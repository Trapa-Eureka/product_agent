import type {
  Approval,
  AuditEvent,
  ChangeRequest,
  EntityId,
  IdempotencyKey,
  IsoDateTime,
  Proposal,
  ProposalStatus,
} from "@pca/contracts";
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
import { assertBelongsToProduction, scopedRecordKey } from "@pca/application";
import type { IdempotencyRecord, ProductionState } from "@pca/domain";

/* eslint-disable @typescript-eslint/require-await --
 * These methods have nothing to await: the store is in memory. They are still
 * declared `async` because the ports promise a `Promise`, and a method that
 * throws synchronously would hand a caller using `.catch()` an exception where
 * it expected a rejection.
 */

/**
 * In-memory repositories.
 *
 * Used by unit tests and by a throwaway demo run. It copies on read and on
 * write so a caller cannot reach in and mutate stored state, which is what a
 * real database would do and what keeps a test failure meaningful.
 */

type Clock = () => IsoDateTime;

const defaultClock: Clock = () => new Date().toISOString();

const copy = <T>(value: T): T => structuredClone(value);

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

export type MemoryStoreOptions = {
  /** Injected so tests can assert an exact `updatedAt` instead of a moving one. */
  readonly now?: Clock;
};

export class MemoryStore implements RepositorySet {
  readonly #now: Clock;
  readonly #productionStates = new Map<EntityId, ProductionState>();
  readonly #changeRequests = new Map<string, ChangeRequest>();
  readonly #proposals = new Map<string, Proposal>();
  readonly #approvals = new Map<string, Approval>();
  readonly #auditEvents: AuditEvent[] = [];
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? defaultClock;
  }

  /**
   * Every method is `async` on purpose. A port that promises a `Promise` must
   * reject rather than throw synchronously, or a caller using `.catch()` gets an
   * exception where it expected a rejection.
   */
  readonly productions: ProductionRepository = {
    loadState: async (productionId) => copy(this.#productionStates.get(productionId) ?? null),

    save: async (state) => {
      this.#assertStateIsolation(state);
      this.#productionStates.set(state.production.id, copy(state));
    },

    commit: async (mutation) => this.#commit(mutation),
  };

  readonly changeRequests: ChangeRequestRepository = {
    save: async (changeRequest) => {
      this.#changeRequests.set(
        scopedKey(changeRequest.productionId, changeRequest.id),
        copy(changeRequest),
      );
    },
    findById: async (productionId, changeRequestId) =>
      copy(this.#changeRequests.get(scopedKey(productionId, changeRequestId)) ?? null),
  };

  readonly proposals: ProposalRepository = {
    save: async (proposal) => {
      this.#proposals.set(scopedKey(proposal.productionId, proposal.id), copy(proposal));
    },
    findById: async (productionId, proposalId) =>
      copy(this.#proposals.get(scopedKey(productionId, proposalId)) ?? null),
    listByStatus: async (productionId: EntityId, status: ProposalStatus) =>
      [...this.#proposals.values()]
        .filter((proposal) => proposal.productionId === productionId && proposal.status === status)
        .map(copy),
  };

  readonly approvals: ApprovalRepository = {
    save: async (approval) => {
      this.#approvals.set(scopedKey(approval.productionId, approval.id), copy(approval));
    },
    findById: async (productionId, approvalId) =>
      copy(this.#approvals.get(scopedKey(productionId, approvalId)) ?? null),
    findByProposalId: async (productionId, proposalId) =>
      copy(
        [...this.#approvals.values()].find(
          (approval) =>
            approval.productionId === productionId && approval.proposalId === proposalId,
        ) ?? null,
      ),
  };

  readonly auditEvents: AuditEventRepository = {
    append: async (event) => {
      this.#auditEvents.push(copy(event));
    },
    list: async (productionId, options) => {
      const matching = this.#auditEvents
        .filter((event) => event.productionId === productionId)
        .reverse();
      const limit = options?.limit;
      return (limit === undefined ? matching : matching.slice(0, limit)).map(copy);
    },
  };

  readonly idempotency: IdempotencyRepository = {
    find: async (productionId: EntityId, key: IdempotencyKey) =>
      copy(this.#idempotency.get(scopedKey(productionId, key)) ?? null),
    save: async (productionId: EntityId, record: IdempotencyRecord) => {
      this.#idempotency.set(scopedKey(productionId, record.key), copy(record));
    },
  };

  /**
   * TASK-901 (code review #1 / SEC-005 / AUD-002): `#commit` and the three
   * follow-up writes below run with no `await` between them, so nothing can
   * observe the mutation without its idempotency/proposal/audit records —
   * the same atomicity guarantee the file and Mongo adapters provide.
   *
   * An arrow-function field, not a class method, for the same reason as the
   * file store: `guardRepositories`/`repositorySetOf` copy `RepositorySet`
   * members out by property access, and only a field is an own enumerable
   * property that keeps its `this` binding once copied.
   */
  readonly applyProposalTransaction = async (
    commit: ApplyProposalCommit,
  ): Promise<CommitOutcome> => {
    const result = this.#commit(commit.mutation);
    if (result.status === "VERSION_MISMATCH") {
      return result;
    }
    this.#proposals.set(
      scopedKey(commit.proposal.productionId, commit.proposal.id),
      copy(commit.proposal),
    );
    this.#idempotency.set(
      scopedKey(commit.mutation.productionId, commit.idempotencyRecord.key),
      copy(commit.idempotencyRecord),
    );
    this.#auditEvents.push(copy(commit.auditEvent));
    return result;
  };

  /**
   * TASK-902 (code review #2 / SEC-004 / AUD-004): the existence check and
   * the three writes run with no `await` between them, so two racing
   * decisions cannot both see "no decision yet" — one records, the other
   * gets `ALREADY_DECIDED` with the record that won.
   */
  readonly recordProposalDecision = async (
    commit: ProposalDecisionCommit,
  ): Promise<DecisionOutcome> => {
    const { productionId, proposalId } = commit.approval;
    const existing = [...this.#approvals.values()].find(
      (approval) => approval.productionId === productionId && approval.proposalId === proposalId,
    );
    if (existing !== undefined) {
      return { status: "ALREADY_DECIDED", approval: copy(existing) };
    }
    this.#approvals.set(scopedKey(productionId, commit.approval.id), copy(commit.approval));
    this.#proposals.set(
      scopedKey(commit.proposal.productionId, commit.proposal.id),
      copy(commit.proposal),
    );
    this.#auditEvents.push(copy(commit.auditEvent));
    return { status: "RECORDED" };
  };

  #assertStateIsolation(state: ProductionState): void {
    const productionId = state.production.id;
    assertBelongsToProduction(productionId, "SCENE", state.scenes);
    assertBelongsToProduction(productionId, "CAST_MEMBER", state.castMembers);
    assertBelongsToProduction(productionId, "LOCATION", state.locations);
    assertBelongsToProduction(productionId, "REQUIREMENT", state.requirements);
    assertBelongsToProduction(productionId, "SHOOT_DAY", state.shootDays);
    assertBelongsToProduction(productionId, "CALL_SHEET", state.callSheets);
    assertBelongsToProduction(productionId, "TASK", state.tasks);
  }

  #commit(mutation: ProductionMutation): CommitOutcome {
    const current = this.#productionStates.get(mutation.productionId);
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
        status: "VERSION_MISMATCH",
        expected: mutation.expectedVersion,
        actual: current.production.version,
      };
    }

    const committedAt = this.#now();
    this.#productionStates.set(mutation.productionId, {
      production: {
        ...current.production,
        version: current.production.version + 1,
        updatedAt: committedAt,
      },
      scenes: upsertById(current.scenes, mutation.scenes),
      castMembers: upsertById(current.castMembers, mutation.castMembers),
      locations: upsertById(current.locations, mutation.locations),
      requirements: upsertById(current.requirements, mutation.requirements),
      shootDays: upsertById(current.shootDays, mutation.shootDays),
      callSheets: upsertById(current.callSheets, mutation.callSheets),
      tasks: upsertById(current.tasks, mutation.tasks),
    });

    return { status: "COMMITTED", productionVersion: current.production.version + 1 };
  }
}

/** TASK-907: the shared unambiguous encoding, so `(A, B::P)` and `(A::B, P)` are two keys. */
const scopedKey = (productionId: EntityId, id: string): string => scopedRecordKey(productionId, id);

export const createMemoryStore = (options?: MemoryStoreOptions): MemoryStore =>
  new MemoryStore(options);
