import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { EntityId, IdempotencyKey, IsoDateTime, ProposalStatus } from "@pca/contracts";
import type {
  ApplyProposalCommit,
  ApprovalRepository,
  AuditEventRepository,
  ChangeRequestRepository,
  CommitOutcome,
  DecisionOutcome,
  IdempotencyRepository,
  Logger,
  ProductionMutation,
  ProductionRepository,
  ProposalDecisionCommit,
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
 * Two deliberate properties:
 *
 * - **One writer at a time, whoever it is.** Every mutation holds an `O_EXCL`
 *   lock file beside the data file for its whole read-check-write (TASK-903),
 *   so a second instance in this process, a `seed` run beside the API, or a
 *   second server on the same path serialise instead of overwriting each
 *   other's version. This is correctness, not throughput: a busy multi-writer
 *   deployment still belongs on `PCA_STORAGE=mongo`.
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
  /**
   * How long one mutation waits for another writer to release the data file
   * before failing with `STORE_LOCKED` (TASK-903). Default 5 seconds: a
   * mutation is a read, a transform, and one small file write, so anything
   * holding the lock longer is stuck, not busy.
   */
  readonly lockTimeoutMs?: number;
  /**
   * What to do when the data file already exists with permissions looser
   * than owner-only (TASK-921): `tighten` (default) chmods it to `0600` and
   * warns; `refuse` throws `STORE_UNSAFE_PERMISSIONS`. A directory is never
   * chmodded — it may not be ours — only warned about.
   */
  readonly permissions?: "tighten" | "refuse";
  /** Receives the permission warnings; silent otherwise. */
  readonly logger?: Logger;
};

/** Owner-only: the store holds schedules, identities, and free text. */
export const DATA_DIRECTORY_MODE = 0o700;
export const DATA_FILE_MODE = 0o600;

/** Bits that grant group or others anything. */
const LOOSE_BITS = 0o077;

/** Windows has no POSIX mode bits; the checks below are a no-op there. */
const POSIX = process.platform !== "win32";

/** How often a waiting writer re-tries the lock. */
const LOCK_POLL_MS = 10;
/**
 * A lock whose owner cannot be identified (unreadable contents) is presumed
 * abandoned once it is this old. A lock naming a dead pid is reclaimed at
 * once; one naming a live pid is waited for, up to `lockTimeoutMs`.
 */
const STALE_LOCK_MS = 30_000;

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

/**
 * Replaces a workflow record by its *scoped* identity (TASK-907, code review
 * #8 / AUD-005). The workflow arrays hold records from every production, so
 * matching on `id` alone let production A's proposal `P-1` overwrite
 * production B's; both parts of the identity are compared now.
 */
const replaceById = <T extends { id: EntityId; productionId: EntityId }>(
  records: T[],
  record: T,
): T[] => {
  const index = records.findIndex(
    (candidate) => candidate.productionId === record.productionId && candidate.id === record.id,
  );
  if (index === -1) {
    return [...records, record];
  }
  return records.map((candidate, position) => (position === index ? record : candidate));
};

export class FileStore implements RepositorySet {
  readonly #filePath: string;
  readonly #now: Clock;
  readonly #lockTimeoutMs: number;
  /**
   * Serialises this instance's read-modify-write cycles. Ordering within one
   * instance only; exclusion against other instances and other processes is
   * the lock file's job (`#acquireLock`, TASK-903).
   */
  #writeQueue: Promise<unknown> = Promise.resolve();
  readonly #permissions: "tighten" | "refuse";
  readonly #logger: Logger | undefined;
  /** The one-time path and permission check, shared by every read and write. */
  #checked: Promise<void> | null = null;

  constructor(options: FileStoreOptions = {}) {
    this.#filePath = options.filePath ?? defaultDataFilePath();
    this.#now = options.now ?? defaultClock;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.#permissions = options.permissions ?? "tighten";
    this.#logger = options.logger;
  }

  /**
   * TASK-921 (SEC-010 / AUD-017): the data file holds cast and location
   * schedules, human-entered change text, identities, approvals, and the
   * audit trail, so it is owner-only. Creates the directory `0700` when it
   * does not exist, refuses a data file or a directory entry that is a
   * symbolic link (a link could point the store at, or leak it to, a path
   * the operator never chose), tightens an existing loose data file to
   * `0600` — or refuses, when so configured — and warns about a loose
   * directory it did not create. Runs once per instance, before the first
   * read or write; the composition root also calls it at startup so a
   * refusal is a startup failure, not a first-request one.
   */
  verify(): Promise<void> {
    this.#checked ??= this.#verifyPath();
    return this.#checked;
  }

  async #verifyPath(): Promise<void> {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: DATA_DIRECTORY_MODE });
    if (!POSIX) return;

    for (const [path, what] of [
      [this.#filePath, "data file"],
      [this.lockPath, "lock file"],
      [directory, "data directory"],
    ] as const) {
      const entry = await lstat(path).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (entry?.isSymbolicLink() === true) {
        throw new Error(
          `STORE_UNSAFE_PATH: ${path} (the ${what}) is a symbolic link; the store refuses to follow it. ` +
            `Point PCA_DATA_FILE at a real file in a directory you own.`,
        );
      }
    }

    const directoryMode = (await stat(directory)).mode & 0o777;
    if ((directoryMode & LOOSE_BITS) !== 0) {
      const message = `${directory} is mode ${directoryMode.toString(8)}; the data directory should be 0700 (owner-only).`;
      if (this.#permissions === "refuse") throw new Error(`STORE_UNSAFE_PERMISSIONS: ${message}`);
      this.#logger?.log("warn", "store_directory_permissions", {
        directory,
        mode: directoryMode.toString(8),
      });
    }

    const file = await stat(this.#filePath).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (file === null) return;
    const fileMode = file.mode & 0o777;
    if ((fileMode & LOOSE_BITS) === 0) return;
    if (this.#permissions === "refuse") {
      throw new Error(
        `STORE_UNSAFE_PERMISSIONS: ${this.#filePath} is mode ${fileMode.toString(8)}; the data file must be 0600 (owner-only). ` +
          `Run chmod 600 on it, or set PCA_DATA_FILE_PERMISSIONS=tighten to have the store do so.`,
      );
    }
    await chmod(this.#filePath, DATA_FILE_MODE);
    this.#logger?.log("warn", "store_file_permissions_tightened", {
      filePath: this.#filePath,
      from: fileMode.toString(8),
      to: DATA_FILE_MODE.toString(8),
    });
  }

  /** Where the writer lock lives: beside the data file, never inside it. */
  get lockPath(): string {
    return `${this.#filePath}.lock`;
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

  /**
   * TASK-801's seed/reset command: replaces one production's state and
   * clears every change request, proposal, approval, audit event, and
   * idempotency record that belongs to it. `productions.save` (the "seed
   * and reset path" for the production's own entities, per
   * `ProductionRepository`'s own doc comment) does not touch these — a
   * demo restarted with a previous run's stale proposals and audit trail
   * sitting alongside the fresh state would not be restored, just
   * contaminated. Not part of `RepositorySet`: this is a file-store-only
   * administrative operation (TASK-806's `seed` subcommand names it that
   * way), not a capability every adapter needs.
   */
  async resetProduction(state: ProductionState): Promise<void> {
    await this.#mutate((database) => {
      assertStateIsolation(state);
      const productionId = state.production.id;
      return {
        database: {
          ...database,
          productions: { ...database.productions, [productionId]: toSnapshot(state) },
          changeRequests: database.changeRequests.filter(
            (record) => record.productionId !== productionId,
          ),
          proposals: database.proposals.filter((record) => record.productionId !== productionId),
          approvals: database.approvals.filter((record) => record.productionId !== productionId),
          auditEvents: database.auditEvents.filter(
            (record) => record.productionId !== productionId,
          ),
          idempotency: database.idempotency.filter(
            (record) => record.productionId !== productionId,
          ),
        },
        result: undefined,
      };
    });
  }

  /**
   * TASK-901 (code review #1 / SEC-005 / AUD-002): the whole apply write in
   * one `#mutate` cycle, so the production mutation, idempotency record,
   * proposal status, and audit event either all land in the same rename or
   * none do. A version mismatch returns the database untouched, same as a
   * plain `productions.commit` mismatch.
   *
   * Declared as an arrow-function field, not a class method: `RepositorySet`
   * methods are read out with `Object.entries`/property access (by
   * `guardRepositories` and `repositorySetOf`) rather than always called as
   * `store.applyProposalTransaction(...)`, and only a field is an own
   * enumerable property that carries its `this` binding along when copied.
   */
  readonly applyProposalTransaction = (commit: ApplyProposalCommit): Promise<CommitOutcome> =>
    this.#mutate((database): { database: FileDatabase; result: CommitOutcome } => {
      const { database: committed, result } = commitInto(database, commit.mutation, this.#now());
      if (result.status === "VERSION_MISMATCH") {
        return { database, result };
      }
      return {
        database: {
          ...committed,
          proposals: replaceById(committed.proposals, commit.proposal),
          idempotency: [
            ...committed.idempotency.filter(
              (candidate) =>
                !(
                  candidate.productionId === commit.mutation.productionId &&
                  candidate.key === commit.idempotencyRecord.key
                ),
            ),
            {
              ...commit.idempotencyRecord,
              affectedEntityIds: [...commit.idempotencyRecord.affectedEntityIds],
              productionId: commit.mutation.productionId,
            },
          ],
          auditEvents: [...committed.auditEvents, commit.auditEvent],
        },
        result,
      };
    });

  /**
   * TASK-902 (code review #2 / SEC-004 / AUD-004): the "no decision yet"
   * check and the three writes share one `#mutate` cycle, so a racing
   * second decision reads the first one's approval and returns
   * `ALREADY_DECIDED` without writing anything of its own.
   */
  readonly recordProposalDecision = (commit: ProposalDecisionCommit): Promise<DecisionOutcome> =>
    this.#mutate((database): { database: FileDatabase; result: DecisionOutcome } => {
      const { productionId, proposalId } = commit.approval;
      const existing = database.approvals.find(
        (record) => record.productionId === productionId && record.proposalId === proposalId,
      );
      if (existing !== undefined) {
        return { database, result: { status: "ALREADY_DECIDED", approval: existing } };
      }
      return {
        database: {
          ...database,
          approvals: replaceById(database.approvals, commit.approval),
          proposals: replaceById(database.proposals, commit.proposal),
          auditEvents: [...database.auditEvents, commit.auditEvent],
        },
        result: { status: "RECORDED" },
      };
    });

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
            { ...record, affectedEntityIds: [...record.affectedEntityIds], productionId },
          ],
        },
        result: undefined,
      })),
  };

  async #read(): Promise<FileDatabase> {
    await this.verify();
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

  /**
   * Read, transform, and write back as one serialised, atomic step — held
   * under the writer lock for the whole cycle (TASK-903), so a second
   * instance or a second process cannot read version N in between and
   * rename its own N+1 over ours. The version check inside `transform` is
   * therefore decided against the file as it really is, not as it was.
   */
  async #mutate<T>(
    transform: (database: FileDatabase) => { database: FileDatabase; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const release = await this.#acquireLock();
      try {
        const current = await this.#read();
        const { database, result } = transform(current);
        await this.#write(database);
        return result;
      } finally {
        await release();
      }
    };

    const queued = this.#writeQueue.then(run, run);
    this.#writeQueue = queued.catch(() => undefined);
    return queued;
  }

  /**
   * TASK-903 (code review #3 / AUD-006): exclusive ownership of the data file
   * for one mutation, across instances and across processes, via a lock file
   * created with `O_EXCL` — the one primitive every platform makes atomic.
   * The in-process `#writeQueue` orders our own mutations; this is what stops
   * a second `FileStore` on the same path (a seed while the API runs, a second
   * server, a stray handle in a test) from losing an approved write.
   *
   * A waiter polls until the lock is free, the owner is found dead, or
   * `lockTimeoutMs` passes, which surfaces as `STORE_LOCKED` rather than a
   * silent lost update. Reads (`#read`) take no lock: rename is atomic, so a
   * reader always sees a whole database, before or after, never a torn one.
   */
  async #acquireLock(): Promise<() => Promise<void>> {
    const { lockPath } = this;
    await this.verify();
    const deadline = Date.now() + this.#lockTimeoutMs;

    for (;;) {
      try {
        const handle = await open(lockPath, "wx", DATA_FILE_MODE);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            "utf8",
          );
        } finally {
          await handle.close();
        }
        return () => unlink(lockPath).catch(() => undefined);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }

      if (await this.#reclaimAbandonedLock()) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `STORE_LOCKED: ${lockPath} has been held by another writer for over ${this.#lockTimeoutMs}ms. ` +
            `Another process is writing ${this.#filePath}; retry once it finishes. ` +
            `If no such process exists, the lock was abandoned and can be deleted.`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  /**
   * Removes a lock whose owner is gone, so a crash while writing does not
   * wall off the store until someone deletes the file by hand. Reclaiming
   * goes through `rename` to a unique name first: if two waiters both find
   * the same abandoned lock, only one rename succeeds, so a lock a third
   * writer creates in between is never removed by the second.
   */
  async #reclaimAbandonedLock(): Promise<boolean> {
    const { lockPath } = this;
    let abandoned = false;
    try {
      const contents = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
      abandoned = typeof contents.pid === "number" && !isProcessAlive(contents.pid);
    } catch (error) {
      if (isNotFound(error)) {
        return true; // released between our open and our read; retry.
      }
      // Unreadable (a writer between open and writeFile, or a foreign file):
      // treat as live unless it has clearly been sitting there.
      const age = await stat(lockPath)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      abandoned = age > STALE_LOCK_MS;
    }
    if (!abandoned) {
      return false;
    }
    const reclaimed = `${lockPath}.${randomUUID()}.abandoned`;
    try {
      await rename(lockPath, reclaimed);
    } catch (error) {
      if (isNotFound(error)) {
        return true; // someone else reclaimed or released it; retry.
      }
      throw error;
    }
    await unlink(reclaimed).catch(() => undefined);
    return true;
  }

  /**
   * Writes to a temporary file and renames it into place. A crash mid-write
   * leaves the previous database intact rather than a half-written one, because
   * rename within a directory is atomic.
   */
  async #write(database: FileDatabase): Promise<void> {
    // TASK-906 (code review #7 / SEC-006 / AUD-010): the same schema that
    // guards every read guards the write. Before this, one record the
    // schema would refuse (a 129-character correlation ID, say) was written
    // successfully and then made every later read fail with STORE_CORRUPT
    // until someone repaired the file by hand. Now the write is refused,
    // names the field, and the previous database stays exactly as it was.
    const checked = fileDatabaseSchema.safeParse(database);
    if (!checked.success) {
      const first = checked.error.issues[0];
      throw new Error(
        `STORE_INVALID_WRITE: refusing to write ${this.#filePath}: ` +
          `"${first?.path.join(".") ?? "<root>"}" ${first?.message ?? "is invalid"}. ` +
          `The previous database is untouched; the record that caused this was not saved.`,
      );
    }

    await this.verify();
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      // Owner-only from the first byte: the mode is set at creation, never
      // fixed up after a window in which the file was readable.
      await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, {
        encoding: "utf8",
        mode: DATA_FILE_MODE,
      });
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

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;

const isNotFound = (error: unknown): boolean => errorCode(error) === "ENOENT";

const isAlreadyExists = (error: unknown): boolean => errorCode(error) === "EEXIST";

/**
 * Signal 0 delivers nothing but still checks the target: `ESRCH` means no such
 * process, `EPERM` means it exists but belongs to someone else — alive either
 * way except `ESRCH`. Our own pid (another `FileStore` in this process) is
 * alive by definition.
 */
const isProcessAlive = (pid: number): boolean => {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  assertBelongsToProduction(mutation.productionId, "CAST_MEMBER", mutation.castMembers);
  assertBelongsToProduction(mutation.productionId, "LOCATION", mutation.locations);
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
          castMembers: upsertById(current.castMembers, mutation.castMembers),
          locations: upsertById(current.locations, mutation.locations),
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
