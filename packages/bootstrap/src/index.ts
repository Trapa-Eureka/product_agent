import type {
  JobRunRepository,
  ModelPort,
  QueuePolicy,
  QueuePort,
  RepositorySet,
} from "@pca/application";
import { guardModelPort } from "@pca/application";
import { createFileStore, defaultDataFilePath } from "@pca/file-store";
import { createMemoryJobRunRepository, createMemoryQueue } from "@pca/memory-queue";
import { createMemoryStore } from "@pca/memory-store";
import { connectMongoStore, defaultMongoUri } from "@pca/mongo-store";
import { createRuleModelAdapter } from "@pca/rule-model";

/**
 * The composition root (ARCHITECTURE.md §9, "Storage adapters").
 *
 * This is the one place that knows more than one adapter exists. Everything
 * below it depends on ports; everything above it (the MCP server, the API, the
 * CLI) asks this module for a RepositorySet and never names a driver.
 *
 * The default is the JSON file store, because it needs no server, no native
 * module, and no account, which is what lets the published package run with
 * `npx` on a clean machine (ARCHITECTURE.md §2, "Free-first constraint").
 */

export type StorageKind = "file" | "memory" | "mongo";

export type StorageSelection =
  | { readonly kind: "file"; readonly filePath: string }
  | { readonly kind: "memory" }
  | { readonly kind: "mongo"; readonly uri: string; readonly databaseName: string | undefined };

export type Environment = Readonly<Record<string, string | undefined>>;

const STORAGE_KINDS: readonly StorageKind[] = ["file", "memory", "mongo"];

/** Reads PCA_STORAGE and its companions; refuses an unknown value loudly. */
export const selectStorage = (env: Environment): StorageSelection => {
  const raw = env["PCA_STORAGE"] ?? "file";
  if (!STORAGE_KINDS.includes(raw as StorageKind)) {
    throw new Error(
      `PCA_STORAGE="${raw}" is not one of ${STORAGE_KINDS.join(", ")}. Unset it for the default file store.`,
    );
  }
  const kind = raw as StorageKind;
  switch (kind) {
    case "file":
      return { kind, filePath: env["PCA_DATA_FILE"] ?? defaultDataFilePath() };
    case "memory":
      return { kind };
    case "mongo":
      return {
        kind,
        uri: env["PCA_MONGO_URI"] ?? defaultMongoUri(),
        databaseName: env["PCA_MONGO_DB"],
      };
  }
};

export type Repositories = {
  readonly repositories: RepositorySet;
  readonly selection: StorageSelection;
  /** Releases connections. A no-op for the file and memory stores. */
  readonly close: () => Promise<void>;
};

export const createRepositories = async (selection: StorageSelection): Promise<Repositories> => {
  switch (selection.kind) {
    case "file":
      return {
        repositories: createFileStore({ filePath: selection.filePath }),
        selection,
        close: () => Promise.resolve(),
      };
    case "memory":
      return { repositories: createMemoryStore(), selection, close: () => Promise.resolve() };
    case "mongo": {
      const store = await connectMongoStore({
        uri: selection.uri,
        ...(selection.databaseName === undefined ? {} : { databaseName: selection.databaseName }),
      });
      return { repositories: store, selection, close: () => store.close() };
    }
  }
};

export const createRepositoriesFromEnv = (env: Environment = process.env): Promise<Repositories> =>
  createRepositories(selectStorage(env));

export type ModelKind = "rules" | "ollama" | "bedrock";

const MODEL_KINDS: readonly ModelKind[] = ["rules", "ollama", "bedrock"];

/** Reads PCA_MODEL; the default is the rule-based adapter, which needs no network and no key. */
export const selectModel = (env: Environment): ModelKind => {
  const raw = env["PCA_MODEL"] ?? "rules";
  if (!MODEL_KINDS.includes(raw as ModelKind)) {
    throw new Error(
      `PCA_MODEL="${raw}" is not one of ${MODEL_KINDS.join(", ")}. Unset it for the rule-based default.`,
    );
  }
  return raw as ModelKind;
};

/** Every model is handed out behind the guard; no caller can reach an unguarded provider. */
export const createModel = (
  kind: ModelKind,
  options: { readonly timeoutMs?: number } = {},
): ModelPort => {
  switch (kind) {
    case "rules":
      return guardModelPort(createRuleModelAdapter(), options);
    case "ollama":
      throw new Error(
        "PCA_MODEL=ollama is not wired yet; the Ollama adapter is an optional later step. Use rules.",
      );
    case "bedrock":
      throw new Error("PCA_MODEL=bedrock is deferred (paid); see TASKS.md TASK-303. Use rules.");
  }
};

export const createModelFromEnv = (env: Environment = process.env): ModelPort =>
  createModel(selectModel(env));

export type QueueKind = "memory" | "sqs";

const QUEUE_KINDS: readonly QueueKind[] = ["memory", "sqs"];

/** Reads PCA_QUEUE; the default is the in-process queue, which needs no broker and no account. */
export const selectQueue = (env: Environment): QueueKind => {
  const raw = env["PCA_QUEUE"] ?? "memory";
  if (!QUEUE_KINDS.includes(raw as QueueKind)) {
    throw new Error(
      `PCA_QUEUE="${raw}" is not one of ${QUEUE_KINDS.join(", ")}. Unset it for the in-process default.`,
    );
  }
  return raw as QueueKind;
};

export const createQueue = (
  kind: QueueKind,
  options: { readonly policy?: Partial<QueuePolicy> } = {},
): QueuePort => {
  switch (kind) {
    case "memory":
      return createMemoryQueue(options);
    case "sqs":
      throw new Error("PCA_QUEUE=sqs is deferred (paid); see TASKS.md TASK-402. Use memory.");
  }
};

export const createQueueFromEnv = (env: Environment = process.env): QueuePort =>
  createQueue(selectQueue(env));

/** Job runs pair with the queue: in-process jobs keep in-process runs. */
export const createJobRuns = (kind: QueueKind): JobRunRepository => {
  switch (kind) {
    case "memory":
      return createMemoryJobRunRepository();
    case "sqs":
      throw new Error("PCA_QUEUE=sqs is deferred (paid); see TASKS.md TASK-402. Use memory.");
  }
};
