import type {
  Approval,
  AuditEvent,
  CallSheet,
  CastMember,
  ChangeRequest,
  EntityId,
  IdempotencyKey,
  IsoDateTime,
  Location,
  Production,
  Proposal,
  ProposalStatus,
  Requirement,
  Scene,
  ShootDay,
  Task,
} from "@pca/contracts";
import { productionStateSchema } from "@pca/contracts";
import type {
  ApplyProposalCommit,
  ApprovalRepository,
  AuditEventRepository,
  ChangeRequestRepository,
  CommitOutcome,
  DecisionOutcome,
  IdempotencyRepository,
  ProductionMutation,
  ProductionRepository,
  ProposalDecisionCommit,
  ProposalRepository,
  RepositorySet,
} from "@pca/application";
import { assertBelongsToProduction } from "@pca/application";
import type { IdempotencyRecord, ProductionState } from "@pca/domain";
import {
  MongoClient,
  type AnyBulkWriteOperation,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
} from "mongodb";

/**
 * MongoDB repository adapter: the portfolio target store (ARCHITECTURE.md §9).
 *
 * Collections follow the documented layout, one per entity kind, each row
 * carrying its `productionId`. Entity rows use a composite `_id` of
 * `productionId::id`, so a scene ID that repeats across productions is two
 * rows rather than a collision, and every read filters by `productionId`
 * whether or not the `_id` already implies it (INV-4 is enforced twice on
 * purpose).
 *
 * `commit` is a multi-document transaction: the version check and every
 * upsert succeed together or not at all (INV-7). That requires a replica set,
 * which is what MongoDB Atlas free tier and `mongodb-memory-server`'s replica
 * set mode both provide. A standalone server is refused at connect time with
 * a message that says so, rather than silently committing without atomicity.
 */

type Clock = () => IsoDateTime;

const defaultClock: Clock = () => new Date().toISOString();

export type MongoStoreOptions = {
  readonly uri: string;
  readonly databaseName?: string;
  readonly now?: Clock;
};

export const defaultMongoUri = (): string =>
  process.env["PCA_MONGO_URI"] ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";

const COLLECTIONS = {
  productions: "productions",
  scenes: "scenes",
  castMembers: "castMembers",
  locations: "locations",
  requirements: "requirements",
  shootDays: "shootDays",
  callSheets: "callSheets",
  tasks: "tasks",
  changeRequests: "changeRequests",
  proposals: "proposals",
  approvals: "approvals",
  auditEvents: "auditEvents",
  idempotency: "idempotency",
} as const;

type EntityRow<T> = T & { _id: string };

/** An untyped row whose `_id` is our composite string key, not an ObjectId. */
type KeyedDocument = Document & { _id: string };

const rowId = (productionId: EntityId, id: string): string => `${productionId}::${id}`;

const toRow = <T extends { id: EntityId; productionId: EntityId }>(record: T): EntityRow<T> => ({
  _id: rowId(record.productionId, record.id),
  ...record,
});

/** Strips Mongo's `_id` so the domain never sees storage detail. */
const fromRow = <T>(row: Document): T => {
  const { _id: _ignored, ...record } = row;
  return record as T;
};

export class MongoStore implements RepositorySet {
  readonly #client: MongoClient;
  readonly #db: Db;
  readonly #now: Clock;

  private constructor(client: MongoClient, db: Db, now: Clock) {
    this.#client = client;
    this.#db = db;
    this.#now = now;
  }

  /** Connects, refuses a standalone server, and ensures the documented indexes. */
  static async connect(options: MongoStoreOptions): Promise<MongoStore> {
    const client = new MongoClient(options.uri);
    await client.connect();
    const db = client.db(options.databaseName ?? "production_change_agent");

    const hello = await db.admin().command({ hello: 1 });
    if (hello["setName"] === undefined) {
      await client.close();
      throw new Error(
        "MONGO_NO_REPLICA_SET: the server is standalone, so commits cannot be transactional. " +
          "Connect to a replica set (Atlas free tier, or mongodb-memory-server in replSet mode).",
      );
    }

    const store = new MongoStore(client, db, options.now ?? defaultClock);
    await store.#ensureIndexes();
    return store;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  get databaseName(): string {
    return this.#db.databaseName;
  }

  /** Index names on a collection, for tests that assert the documented layout. */
  async indexNames(name: keyof typeof COLLECTIONS): Promise<string[]> {
    const indexes = await this.#collection(name).indexes();
    return indexes.map((index) => index.name ?? "").filter((indexName) => indexName !== "");
  }

  #collection<T extends Document>(name: keyof typeof COLLECTIONS): Collection<T> {
    return this.#db.collection<T>(COLLECTIONS[name]);
  }

  async #ensureIndexes(): Promise<void> {
    const byProduction = { productionId: 1 } as const;
    await this.#ensureUniqueApprovalPerProposal();
    await Promise.all([
      this.#collection("scenes").createIndexes([
        { key: byProduction },
        { key: { productionId: 1, requiredCastIds: 1 } },
        { key: { productionId: 1, locationId: 1 } },
      ]),
      this.#collection("shootDays").createIndex({ productionId: 1, date: 1 }),
      this.#collection("proposals").createIndex({ productionId: 1, status: 1 }),
      this.#collection("auditEvents").createIndex({ productionId: 1, _id: -1 }),
      this.#collection("idempotency").createIndex({ productionId: 1, key: 1 }, { unique: true }),
      ...(
        [
          "castMembers",
          "locations",
          "requirements",
          "callSheets",
          "tasks",
          "changeRequests",
        ] as const
      ).map((name) => this.#collection(name).createIndex(byProduction)),
    ]);
  }

  /**
   * TASK-902: one decision per proposal is enforced by the database itself,
   * so two racing inserts cannot both land whatever the application does.
   * Mongo refuses to change an existing index's options in place, and every
   * store created before this task carries the same key as a non-unique
   * index, so that one is dropped first; a fresh database has nothing to drop.
   */
  async #ensureUniqueApprovalPerProposal(): Promise<void> {
    const approvals = this.#collection("approvals");
    const indexes = await approvals.indexes().catch(() => []);
    const stale = indexes.find(
      (index) =>
        JSON.stringify(index.key) === JSON.stringify({ productionId: 1, proposalId: 1 }) &&
        index.unique !== true,
    );
    if (stale?.name !== undefined) {
      await approvals.dropIndex(stale.name);
    }
    await approvals.createIndex({ productionId: 1, proposalId: 1 }, { unique: true });
  }

  async #loadState(
    productionId: EntityId,
    session?: ClientSession,
  ): Promise<ProductionState | null> {
    // exactOptionalPropertyTypes: an absent session must be absent, not undefined.
    const inSession = session === undefined ? {} : { session };
    const production = await this.#collection<EntityRow<Production>>("productions").findOne(
      { _id: productionId },
      inSession,
    );
    if (production === null) {
      return null;
    }

    const filter = { productionId };
    const options = { ...inSession, sort: { _id: 1 as const } };
    const [scenes, castMembers, locations, requirements, shootDays, callSheets, tasks] =
      await Promise.all([
        this.#collection("scenes").find(filter, options).toArray(),
        this.#collection("castMembers").find(filter, options).toArray(),
        this.#collection("locations").find(filter, options).toArray(),
        this.#collection("requirements").find(filter, options).toArray(),
        this.#collection("shootDays").find(filter, options).toArray(),
        this.#collection("callSheets").find(filter, options).toArray(),
        this.#collection("tasks").find(filter, options).toArray(),
      ]);

    const assembled = {
      production: fromRow<Production>(production),
      scenes: scenes.map((row) => fromRow<Scene>(row)),
      castMembers: castMembers.map((row) => fromRow<CastMember>(row)),
      locations: locations.map((row) => fromRow<Location>(row)),
      requirements: requirements.map((row) => fromRow<Requirement>(row)),
      shootDays: shootDays.map((row) => fromRow<ShootDay>(row)),
      callSheets: callSheets.map((row) => fromRow<CallSheet>(row)),
      tasks: tasks.map((row) => fromRow<Task>(row)),
    };

    const parsed = productionStateSchema.safeParse(assembled);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(
        `STORE_CORRUPT: production ${productionId} in MongoDB does not match the expected shape at ` +
          `"${first?.path.join(".") ?? "<root>"}": ${first?.message ?? "unknown issue"}.`,
      );
    }
    return parsed.data;
  }

  readonly productions: ProductionRepository = {
    loadState: (productionId) => this.#loadState(productionId),

    save: async (state) => {
      assertStateIsolation(state);
      const productionId = state.production.id;
      await this.#client.withSession((session) =>
        session.withTransaction(async () => {
          await this.#collection<EntityRow<Production>>("productions").replaceOne(
            { _id: productionId },
            { ...state.production },
            { upsert: true, session },
          );
          // Generic helpers work on untyped documents; the typed reads are what
          // matter, and they validate through the contract schema on load.
          const replaceAll = async <T extends { id: EntityId; productionId: EntityId }>(
            name: keyof typeof COLLECTIONS,
            records: readonly T[],
          ): Promise<void> => {
            const collection = this.#collection<KeyedDocument>(name);
            await collection.deleteMany({ productionId }, { session });
            if (records.length > 0) {
              await collection.insertMany(
                records.map((record) => toRow(record) as KeyedDocument),
                { session },
              );
            }
          };
          await replaceAll("scenes", state.scenes);
          await replaceAll("castMembers", state.castMembers);
          await replaceAll("locations", state.locations);
          await replaceAll("requirements", state.requirements);
          await replaceAll("shootDays", state.shootDays);
          await replaceAll("callSheets", state.callSheets);
          await replaceAll("tasks", state.tasks);
        }),
      );
    },

    commit: (mutation) => this.#commit(mutation),
  };

  /**
   * TASK-901 (code review #1 / SEC-005 / AUD-002): the version-checked
   * mutation, the idempotency record, the proposal's next status, and its
   * audit event commit inside the same session/transaction as the mutation
   * itself, so a version mismatch — or any failure — leaves every one of
   * them untouched.
   *
   * An arrow-function field, not a class method, for the same reason as the
   * file and memory stores: `guardRepositories`/`repositorySetOf` copy
   * `RepositorySet` members out by property access, and only a field is an
   * own enumerable property that keeps its `this` binding once copied.
   */
  readonly applyProposalTransaction = (commit: ApplyProposalCommit): Promise<CommitOutcome> =>
    this.#commit(commit.mutation, async (session) => {
      await this.#collection<EntityRow<Proposal>>("proposals").replaceOne(
        { _id: rowId(commit.proposal.productionId, commit.proposal.id) },
        toRow(commit.proposal),
        { upsert: true, session },
      );
      await this.#collection<Document>("idempotency").replaceOne(
        { productionId: commit.mutation.productionId, key: commit.idempotencyRecord.key },
        {
          productionId: commit.mutation.productionId,
          ...commit.idempotencyRecord,
          affectedEntityIds: [...commit.idempotencyRecord.affectedEntityIds],
        },
        { upsert: true, session },
      );
      await this.#collection<AuditEvent>("auditEvents").insertOne(
        { ...commit.auditEvent },
        { session },
      );
    });

  /**
   * TASK-902 (code review #2 / SEC-004 / AUD-004): one transaction, with two
   * layers of "first decision wins". The read inside the transaction turns
   * an already-present approval into `ALREADY_DECIDED` cheaply; the unique
   * `(productionId, proposalId)` index catches the true race where two
   * transactions both read nothing — the loser's insert fails with a
   * duplicate key, its transaction aborts, and it answers with the record
   * that beat it instead of an error.
   */
  readonly recordProposalDecision = async (
    commit: ProposalDecisionCommit,
  ): Promise<DecisionOutcome> => {
    const { productionId, proposalId } = commit.approval;
    const approvals = this.#collection<EntityRow<Approval>>("approvals");
    const winner = async (session?: ClientSession): Promise<Approval | null> => {
      const row = await approvals.findOne(
        { productionId, proposalId },
        { sort: { _id: 1 }, ...(session === undefined ? {} : { session }) },
      );
      return row === null ? null : fromRow<Approval>(row);
    };

    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(async (): Promise<DecisionOutcome> => {
          const existing = await winner(session);
          if (existing !== null) {
            await session.abortTransaction();
            return { status: "ALREADY_DECIDED", approval: existing };
          }
          await approvals.insertOne(toRow(commit.approval), { session });
          await this.#collection<EntityRow<Proposal>>("proposals").replaceOne(
            { _id: rowId(commit.proposal.productionId, commit.proposal.id) },
            toRow(commit.proposal),
            { upsert: true, session },
          );
          await this.#collection<AuditEvent>("auditEvents").insertOne(
            { ...commit.auditEvent },
            { session },
          );
          return { status: "RECORDED" };
        }),
      );
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      const existing = await winner();
      if (existing === null) {
        throw error;
      }
      return { status: "ALREADY_DECIDED", approval: existing };
    }
  };

  async #commit(
    mutation: ProductionMutation,
    withinTransaction?: (session: ClientSession) => Promise<void>,
  ): Promise<CommitOutcome> {
    const { productionId } = mutation;
    assertBelongsToProduction(productionId, "CAST_MEMBER", mutation.castMembers);
    assertBelongsToProduction(productionId, "LOCATION", mutation.locations);
    assertBelongsToProduction(productionId, "SCENE", mutation.scenes);
    assertBelongsToProduction(productionId, "REQUIREMENT", mutation.requirements);
    assertBelongsToProduction(productionId, "SHOOT_DAY", mutation.shootDays);
    assertBelongsToProduction(productionId, "CALL_SHEET", mutation.callSheets);
    assertBelongsToProduction(productionId, "TASK", mutation.tasks);

    const productions = this.#collection<EntityRow<Production>>("productions");
    const existing = await productions.findOne({ _id: productionId });
    if (existing === null) {
      throw new Error(
        `ENTITY_NOT_FOUND: production ${productionId} does not exist. Seed it before committing.`,
      );
    }

    return this.#client.withSession((session) =>
      session.withTransaction(async (): Promise<CommitOutcome> => {
        const nextVersion = mutation.expectedVersion + 1;
        const bumped = await productions.findOneAndUpdate(
          { _id: productionId, version: mutation.expectedVersion },
          { $set: { version: nextVersion, updatedAt: this.#now() } },
          { session, returnDocument: "after" },
        );
        if (bumped === null) {
          const current = await productions.findOne({ _id: productionId }, { session });
          await session.abortTransaction();
          return {
            status: "VERSION_MISMATCH",
            expected: mutation.expectedVersion,
            actual: current?.version ?? -1,
          };
        }

        const upsertAll = async <T extends { id: EntityId; productionId: EntityId }>(
          name: keyof typeof COLLECTIONS,
          records: readonly T[] | undefined,
        ): Promise<void> => {
          if (records === undefined || records.length === 0) {
            return;
          }
          const operations: AnyBulkWriteOperation<KeyedDocument>[] = records.map((record) => ({
            replaceOne: {
              filter: { _id: rowId(productionId, record.id) },
              replacement: toRow(record),
              upsert: true,
            },
          }));
          await this.#collection<KeyedDocument>(name).bulkWrite(operations, {
            session,
            ordered: true,
          });
        };
        await upsertAll("castMembers", mutation.castMembers);
        await upsertAll("locations", mutation.locations);
        await upsertAll("scenes", mutation.scenes);
        await upsertAll("requirements", mutation.requirements);
        await upsertAll("shootDays", mutation.shootDays);
        await upsertAll("callSheets", mutation.callSheets);
        await upsertAll("tasks", mutation.tasks);

        await withinTransaction?.(session);

        return { status: "COMMITTED", productionVersion: nextVersion };
      }),
    );
  }

  readonly changeRequests: ChangeRequestRepository = {
    save: async (changeRequest) => {
      await this.#collection<EntityRow<ChangeRequest>>("changeRequests").replaceOne(
        { _id: rowId(changeRequest.productionId, changeRequest.id) },
        toRow(changeRequest),
        { upsert: true },
      );
    },
    findById: async (productionId, changeRequestId) => {
      const row = await this.#collection<EntityRow<ChangeRequest>>("changeRequests").findOne({
        _id: rowId(productionId, changeRequestId),
        productionId,
      });
      return row === null ? null : fromRow<ChangeRequest>(row);
    },
  };

  readonly proposals: ProposalRepository = {
    save: async (proposal) => {
      await this.#collection<EntityRow<Proposal>>("proposals").replaceOne(
        { _id: rowId(proposal.productionId, proposal.id) },
        toRow(proposal),
        { upsert: true },
      );
    },
    findById: async (productionId, proposalId) => {
      const row = await this.#collection<EntityRow<Proposal>>("proposals").findOne({
        _id: rowId(productionId, proposalId),
        productionId,
      });
      return row === null ? null : fromRow<Proposal>(row);
    },
    listByStatus: async (productionId: EntityId, status: ProposalStatus) => {
      const rows = await this.#collection<EntityRow<Proposal>>("proposals")
        .find({ productionId, status }, { sort: { _id: 1 } })
        .toArray();
      return rows.map((row) => fromRow<Proposal>(row));
    },
  };

  readonly approvals: ApprovalRepository = {
    save: async (approval) => {
      await this.#collection<EntityRow<Approval>>("approvals").replaceOne(
        { _id: rowId(approval.productionId, approval.id) },
        toRow(approval),
        { upsert: true },
      );
    },
    findById: async (productionId, approvalId) => {
      const row = await this.#collection<EntityRow<Approval>>("approvals").findOne({
        _id: rowId(productionId, approvalId),
        productionId,
      });
      return row === null ? null : fromRow<Approval>(row);
    },
    findByProposalId: async (productionId, proposalId) => {
      const row = await this.#collection<EntityRow<Approval>>("approvals").findOne(
        { productionId, proposalId },
        { sort: { _id: 1 } },
      );
      return row === null ? null : fromRow<Approval>(row);
    },
  };

  /**
   * Audit rows keep Mongo's own ObjectId `_id`, which increases with insertion
   * order inside a process. "Newest first" therefore means `_id` descending,
   * which stays correct even when two events share a timestamp.
   */
  readonly auditEvents: AuditEventRepository = {
    append: async (event) => {
      await this.#collection<AuditEvent>("auditEvents").insertOne({ ...event });
    },
    list: async (productionId, options) => {
      const cursor = this.#collection<AuditEvent>("auditEvents").find(
        { productionId },
        { sort: { _id: -1 } },
      );
      if (options?.limit !== undefined) {
        cursor.limit(options.limit);
      }
      const rows = await cursor.toArray();
      return rows.map((row) => fromRow<AuditEvent>(row));
    },
  };

  readonly idempotency: IdempotencyRepository = {
    find: async (productionId: EntityId, key: IdempotencyKey) => {
      const row = await this.#collection<Document>("idempotency").findOne({ productionId, key });
      if (row === null) {
        return null;
      }
      const { _id: _ignored, productionId: _scope, ...record } = row;
      return record as IdempotencyRecord;
    },
    save: async (productionId: EntityId, record: IdempotencyRecord) => {
      await this.#collection<Document>("idempotency").replaceOne(
        { productionId, key: record.key },
        { productionId, ...record, affectedEntityIds: [...record.affectedEntityIds] },
        { upsert: true },
      );
    },
  };
}

/**
 * Mongo reports a unique-index violation as error code 11000, either on the
 * write error itself or on the error that aborts the enclosing transaction.
 */
const isDuplicateKey = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return code === 11000 || isDuplicateKey(cause);
};

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

export const connectMongoStore = (options: MongoStoreOptions): Promise<MongoStore> =>
  MongoStore.connect(options);
