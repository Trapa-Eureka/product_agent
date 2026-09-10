import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { EntityId, IdempotencyKey, IsoDateTime, ProposalStatus } from "@pca/contracts";
import type {
  ApprovalRepository,
  AuditEventRepository,
  ChangeRequestRepository,
  CommitOutcome,
  IdempotencyRepository,
  ProductionMutation,
  ProductionRepository,
  ProposalRepository,
  RepositorySet,
} from "@pca/application";
import { assertBelongsToProduction } from "@pca/application";
import type { IdempotencyRecord, ProductionState } from "@pca/domain";

import type { ProductionStateSnapshot } from "@pca/contracts";

import type { FileDatabase } from "./database";
import { emptyDatabase, fileDatabaseSchema } from "./database";

export * from "./database";

/**
 * JSON file repository adapter: the free, zero-install default.
 *
 * It needs no server, no native module, and no account, which is what lets the
 * published package run the whole product with `npx` on a clean machine
 * (ARCHITECTURE.md §2, "Free-first constraint").
 *
 * Two deliberate limits:
 *
 * - **Single process.** Writes are serialised in-process; two processes writing
 *   the same file can still lose an update. Multi-writer deployments switch to
 *   `PCA_STORAGE=mongo`.
 * - **Read-through.** Every read parses the file rather than caching it, so a
 *   second instance sees the first one's writes. The file is small, and
 *   correctness beats a cache nobody asked for.
 */

type Clock = () => IsoDateTime;

const defaultClock: Clock = () => new Date().toISOString();

export const defaultDataFilePath = (): string =>
  process.env["PCA_DATA_FILE"] ?? join(homedir(), ".production-change-agent", "data.json");

export type FileStoreOptions = {
  readonly filePath?: string;
  /** Injected so tests can assert an exact `updatedAt` instead of a moving one. */
  readonly now?: Clock;
};

const upsertById = <T extends { id: EntityId }>(
  existing: readonly T[],
  incoming: readonly T[] | undefined,
): T[] => {
  if (incoming === undefined || incoming.length === 0) {
    return [...existing];
  }
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) {
    byId.set(record.id, record);
  }
  return [...byId.values()];
};

const replaceById = <T extends { id: EntityId }>(records: T[], record: T): T[] => {
  const index = records.findIndex((candidate) => candidate.id === record.id);
  if (index === -1) {
    return [...records, record];
  }
  return records.map((candidate, position) => (position === index ? record : candidate));
};

export class FileStore implements RepositorySet {
  readonly #filePath: string;
  readonly #now: Clock;
  /** Serialises read-modify-write cycles so concurrent commits cannot interleave. */
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileStoreOptions = {}) {
    this.#filePath = options.filePath ?? defaultDataFilePath();
    this.#now = options.now ?? defaultClock;
  }

  get filePath(): string {
    return this.#filePath;
  }

  readonly productions: ProductionRepository = {
    loadState: async (productionId) => {
      const database = await this.#read();
      return database.productions[productionId] ?? null;
    },

    save: (state) =>
      this.#mutate((database) => {
        assertStateIsolation(state);
        return {
          database: {
            ...database,
            productions: { ...database.productions, [state.production.id]: toSnapshot(state) },
          },
          result: undefined,
        };
      }),

    commit: (mutation) => this.#mutate((database) => commitInto(database, mutation, this.#now())),
  };

  readonly changeRequests: ChangeRequestRepository = {
    save: (changeRequest) =>
      this.#mutate((database) => ({
        database: {
          ...database,
          changeRequests: replaceById(database.changeRequests, changeRequest),
        },
        result: undefined,
      })),

    findById: async (productionId, changeRequestId) => {
      const database = await this.#read();
      return (
        database.changeRequests.find(
          (record) => record.productionId === productionId && record.id === changeRequestId,
        ) ?? null
      );
    },
  };

  readonly proposals: ProposalRepository = {
    save: (proposal) =>
      this.#mutate((database) => ({
        database: { ...database, proposals: replaceById(database.proposals, proposal) },
        result: undefined,
      })),

    findById: async (productionId, proposalId) => {
      const database = await this.#read();
      return (
        database.proposals.find(
          (record) => record.productionId === productionId && record.id === proposalId,
        ) ?? null
      );
    },

    listByStatus: async (productionId: EntityId, status: ProposalStatus) => {
      const database = await this.#read();
      return database.proposals.filter(
        (record) => record.productionId === productionId && record.status === status,
      );
    },
  };

  readonly approvals: ApprovalRepository = {
    save: (approval) =>
      this.#mutate((database) => ({
        database: { ...database, approvals: replaceById(database.approvals, approval) },
        result: undefined,
      })),

    findById: async (productionId, approvalId) => {
      const database = await this.#read();
      return (
        database.approvals.find(
          (record) => record.productionId === productionId && record.id === approvalId,
        ) ?? null
      );
    },

    findByProposalId: async (productionId, proposalId) => {
      const database = await this.#read();
      return (
        database.approvals.find(
          (record) => record.productionId === productionId && record.proposalId === proposalId,
        ) ?? null
      );
    },
  };

  readonly auditEvents: AuditEventRepository = {
    append: (event) =>
      this.#mutate((database) => ({
        database: { ...database, auditEvents: [...database.auditEvents, event] },
        result: undefined,
      })),

    list: async (productionId, options) => {
      const database = await this.#read();
      const matching = database.auditEvents
        .filter((event) => event.productionId === productionId)
        .reverse();
      const limit = options?.limit;
      return limit === undefined ? matching : matching.slice(0, limit);
    },
  };

  readonly idempotency: IdempotencyRepository = {
    find: async (productionId: EntityId, key: IdempotencyKey) => {
      const database = await this.#read();
      const stored = database.idempotency.find(
        (record) => record.productionId === productionId && record.key === key,
      );
      if (stored === undefined) {
        return null;
      }
      const { productionId: _scope, ...record } = stored;
      return record;
    },

    save: (productionId: EntityId, record: IdempotencyRecord) =>
      this.#mutate((database) => ({
        database: {
          ...database,
          idempotency: [
            ...database.idempotency.filter(
              (candidate) =>
                !(candidate.productionId === productionId && candidate.key === record.key),
            ),
            { ...record, productionId },
          ],
        },
        result: undefined,
      })),
  };

  async #read(): Promise<FileDatabase> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return emptyDatabase();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `STORE_CORRUPT: ${this.#filePath} is not valid JSON. ` +
          `Restore it from a backup or re-seed the production. Cause: ${String(error)}`,
      );
    }

    const result = fileDatabaseSchema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new Error(
        `STORE_CORRUPT: ${this.#filePath} does not match the expected format at ` +
          `"${first?.path.join(".") ?? "<root>"}": ${first?.message ?? "unknown issue"}. ` +
          `Re-seed the production or restore the file from a backup.`,
      );
    }
    return result.data;
  }

  /** Read, transform, and write back as one serialised, atomic step. */
  async #mutate<T>(
    transform: (database: FileDatabase) => { database: FileDatabase; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const current = await this.#read();
      const { database, result } = transform(current);
      await this.#write(database);
      return result;
    };

    const queued = this.#writeQueue.then(run, run);
    this.#writeQueue = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Writes to a temporary file and renames it into place. A crash mid-write
   * leaves the previous database intact rather than a half-written one, because
   * rename within a directory is atomic.
   */
  async #write(database: FileDatabase): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * The domain hands out read-only arrays; the stored snapshot owns its own. The
 * copy is what makes that ownership real rather than a promise.
 */
const toSnapshot = (state: ProductionState): ProductionStateSnapshot => ({
  production: state.production,
  scenes: [...state.scenes],
  castMembers: [...state.castMembers],
  locations: [...state.locations],
  requirements: [...state.requirements],
  shootDays: [...state.shootDays],
  callSheets: [...state.callSheets],
  tasks: [...state.tasks],
});

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

const assertStateIsolation = (state: ProductionState): void => {
  const productionId = state.production.id;
  assertBelongsToProduction(productionId, "SCENE", state.scenes);
  assertBelongsToProduction(productionId, "CAST_MEMBER", state.castMembers);
  assertBelongsToProduction(productionId, "LOCATION", state.locations);
  assertBelongsToProduction(productionId, "REQUIREMENT", state.requirements);
  assertBelongsToProduction(productionId, "SHOOT_DAY", state.shootDays);
  assertBelongsToProduction(productionId, "CALL_SHEET", state.callSheets);
  assertBelongsToProduction(productionId, "TASK", state.tasks);
};

const commitInto = (
  database: FileDatabase,
  mutation: ProductionMutation,
  committedAt: IsoDateTime,
): { database: FileDatabase; result: CommitOutcome } => {
  const current = database.productions[mutation.productionId];
  if (current === undefined) {
    throw new Error(
      `ENTITY_NOT_FOUND: production ${mutation.productionId} does not exist. Seed it before committing.`,
    );
  }

  assertBelongsToProduction(mutation.productionId, "SCENE", mutation.scenes);
  assertBelongsToProduction(mutation.productionId, "REQUIREMENT", mutation.requirements);
  assertBelongsToProduction(mutation.productionId, "SHOOT_DAY", mutation.shootDays);
  assertBelongsToProduction(mutation.productionId, "CALL_SHEET", mutation.callSheets);
  assertBelongsToProduction(mutation.productionId, "TASK", mutation.tasks);

  if (current.production.version !== mutation.expectedVersion) {
    return {
      database,
      result: {
        status: "VERSION_MISMATCH",
        expected: mutation.expectedVersion,
        actual: current.production.version,
      },
    };
  }

  const nextVersion = current.production.version + 1;
  return {
    database: {
      ...database,
      productions: {
        ...database.productions,
        [mutation.productionId]: {
          production: { ...current.production, version: nextVersion, updatedAt: committedAt },
          scenes: upsertById(current.scenes, mutation.scenes),
          castMembers: current.castMembers,
          locations: current.locations,
          requirements: upsertById(current.requirements, mutation.requirements),
          shootDays: upsertById(current.shootDays, mutation.shootDays),
          callSheets: upsertById(current.callSheets, mutation.callSheets),
          tasks: upsertById(current.tasks, mutation.tasks),
        },
      },
    },
    result: { status: "COMMITTED", productionVersion: nextVersion },
  };
};

export const createFileStore = (options?: FileStoreOptions): FileStore => new FileStore(options);
