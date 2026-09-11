import type {
  Clock,
  IdentityPort,
  JobRunRepository,
  Logger,
  ModelPort,
  PortGuardOptions,
  QueuePolicy,
  QueuePort,
  RepositorySet,
} from "@pca/application";
import { guardModelPort, guardRepositories, systemClock } from "@pca/application";
import type { EntityId, Principal } from "@pca/contracts";
import { createFileStore, defaultDataFilePath } from "@pca/file-store";
import { createDemoMovie } from "@pca/fixtures";
import {
  MIN_SECRET_LENGTH,
  createLocalIdentity,
  generateAuthSecret,
  issueToken,
} from "@pca/local-auth";
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

/** The `RepositorySet` surface of a store, without whatever else the adapter exposes (a `close`, a client). */
const repositorySetOf = (store: RepositorySet): RepositorySet => ({
  productions: store.productions,
  changeRequests: store.changeRequests,
  proposals: store.proposals,
  approvals: store.approvals,
  auditEvents: store.auditEvents,
  idempotency: store.idempotency,
  applyProposalTransaction: store.applyProposalTransaction,
  recordProposalDecision: store.recordProposalDecision,
});

export const createRepositories = async (
  selection: StorageSelection,
  options: PortGuardOptions = {},
): Promise<Repositories> => {
  switch (selection.kind) {
    case "file":
      return {
        repositories: guardRepositories(
          "file",
          repositorySetOf(createFileStore({ filePath: selection.filePath })),
          options,
        ),
        selection,
        close: () => Promise.resolve(),
      };
    case "memory":
      return {
        repositories: guardRepositories("memory", repositorySetOf(createMemoryStore()), options),
        selection,
        close: () => Promise.resolve(),
      };
    case "mongo": {
      const store = await connectMongoStore({
        uri: selection.uri,
        ...(selection.databaseName === undefined ? {} : { databaseName: selection.databaseName }),
      });
      return {
        repositories: guardRepositories("mongo", repositorySetOf(store), options),
        selection,
        close: () => store.close(),
      };
    }
  }
};

/** `options.logger` (TASK-804) logs one `db_call` line per repository call, across every adapter. */
export const createRepositoriesFromEnv = (
  env: Environment = process.env,
  options: PortGuardOptions = {},
): Promise<Repositories> => createRepositories(selectStorage(env), options);

export type ResetDemoMovieResult = {
  readonly filePath: string;
  readonly productionId: EntityId;
};

/**
 * TASK-801's seed/reset command: one call restores the Demo Movie fixture,
 * reusable by TASK-806's future `seed` CLI subcommand exactly as it is here.
 *
 * File-store only, deliberately: `FileStore.resetProduction` is the only
 * adapter that clears a production's stale change requests, proposals,
 * approvals, audit events, and idempotency records along with its state
 * (`productions.save` alone never touches those — a demo "restored" while
 * still carrying a previous run's proposals and audit trail would not be
 * restored, just contaminated), and the memory store needs no reset since
 * nothing survives past the process anyway. Any other `PCA_STORAGE` refuses
 * loudly rather than silently doing a lesser reset it cannot really
 * support.
 */
export const resetDemoMovie = async (
  env: Environment = process.env,
): Promise<ResetDemoMovieResult> => {
  const selection = selectStorage(env);
  if (selection.kind !== "file") {
    throw new Error(
      `The seed/reset command only resets the file store. PCA_STORAGE="${selection.kind}" is not "file" (or unset).`,
    );
  }
  const store = createFileStore({ filePath: selection.filePath });
  const state = createDemoMovie();
  await store.resetProduction(state);
  return { filePath: selection.filePath, productionId: state.production.id };
};

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

export type ModelOptions = {
  readonly timeoutMs?: number;
  /** Logs one `model_call` line per call (TASK-804): operation, durationMs, outcome. */
  readonly logger?: Logger;
};

/** Every model is handed out behind the guard; no caller can reach an unguarded provider. */
export const createModel = (kind: ModelKind, options: ModelOptions = {}): ModelPort => {
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

export const createModelFromEnv = (
  env: Environment = process.env,
  options: ModelOptions = {},
): ModelPort => createModel(selectModel(env), options);

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

/**
 * Identity (TASK-914, SEC-001 / AUD-001).
 *
 * Two modes, chosen by the environment and never by a request:
 *
 * - **token** — `PCA_AUTH_SECRET` is set (≥ 32 characters). Every REST call
 *   and WebSocket upgrade must carry a token signed with it; the operator
 *   mints tokens with `pnpm run token`. Maker-checker is on unless
 *   `PCA_MAKER_CHECKER=false`.
 * - **demo** — `PCA_DEMO_MODE=true` and no secret. The server signs with an
 *   ephemeral secret and hands anyone who asks `GET /api/auth/demo-session`
 *   a token for the demo coordinator, so `npx … serve` still runs the golden
 *   scenarios with zero configuration. Maker-checker is off unless
 *   `PCA_MAKER_CHECKER=true`. The startup log says so loudly.
 *
 * Neither set: startup fails. A deployment that forgot its secret must not
 * come up open (AUD-003's fail-closed principle, applied to identity).
 */

export type AuthMode = "token" | "demo";

export type AuthSelection = {
  readonly mode: AuthMode;
  readonly identity: IdentityPort;
  /** Demo mode only: mints the demo coordinator's token for the public demo-session route. */
  readonly demoSession?: () => string;
  readonly makerChecker: boolean;
};

/** The identity every demo session runs as; `"*"` because a demo has one operator and one production. */
export const DEMO_PRINCIPAL: Principal = {
  subject: "demo-coordinator",
  issuer: "pca-demo",
  type: "USER",
  roles: ["approver"],
  productions: "*",
};

const isTrue = (value: string | undefined): boolean => value?.trim().toLowerCase() === "true";
const isFalse = (value: string | undefined): boolean => value?.trim().toLowerCase() === "false";

export const selectAuth = (env: Environment, clock: Clock = systemClock): AuthSelection => {
  const secret = env["PCA_AUTH_SECRET"]?.trim();
  if (secret !== undefined && secret.length > 0) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `PCA_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }
    return {
      mode: "token",
      identity: createLocalIdentity({ secret, clock }),
      makerChecker: !isFalse(env["PCA_MAKER_CHECKER"]),
    };
  }
  if (isTrue(env["PCA_DEMO_MODE"])) {
    const ephemeral = generateAuthSecret();
    return {
      mode: "demo",
      identity: createLocalIdentity({ secret: ephemeral, clock }),
      demoSession: () => issueToken({ secret: ephemeral, principal: DEMO_PRINCIPAL, clock }),
      makerChecker: isTrue(env["PCA_MAKER_CHECKER"]),
    };
  }
  throw new Error(
    "No identity configured: set PCA_AUTH_SECRET (a 32+ character secret; tokens are minted with `pnpm run token`) for a deployment, or PCA_DEMO_MODE=true for a local demo where anyone reaching the server is the demo coordinator.",
  );
};
