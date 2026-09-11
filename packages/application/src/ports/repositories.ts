import type {
  Approval,
  AuditEvent,
  CallSheet,
  CastMember,
  ChangeRequest,
  Location,
  EntityId,
  IdempotencyKey,
  Proposal,
  ProposalStatus,
  ProductionVersion,
  Requirement,
  Scene,
  ShootDay,
  Task,
} from "@pca/contracts";
import type { IdempotencyRecord, ProductionState } from "@pca/domain";

/**
 * Repository ports.
 *
 * The application depends on these interfaces, never on a driver. Swapping the
 * JSON file store for MongoDB must not change a single use case, and the same
 * contract test suite runs against every adapter so "it compiles" is not
 * mistaken for "it behaves".
 *
 * Two rules bind every implementation:
 *
 * 1. Production isolation (INV-4). Every method takes a `productionId` and must
 *    behave as though other productions do not exist. A lookup with the wrong
 *    production returns nothing; it never returns another tenant's record.
 * 2. Reads return `null` for "not found" and throw only for genuine faults, so
 *    an expected absence is never dressed up as an outage.
 */

/**
 * A batch of entity writes applied as one unit.
 *
 * The MVP's four operations only ever insert or update, so there is no delete
 * here. Adding one later should be a deliberate decision with its own
 * invariant, not a capability that arrived unnoticed.
 */
export type ProductionMutation = {
  readonly productionId: EntityId;
  /** The version the caller simulated against. A mismatch aborts the commit (INV-6). */
  readonly expectedVersion: ProductionVersion;
  readonly castMembers?: readonly CastMember[];
  readonly locations?: readonly Location[];
  readonly scenes?: readonly Scene[];
  readonly requirements?: readonly Requirement[];
  readonly shootDays?: readonly ShootDay[];
  readonly callSheets?: readonly CallSheet[];
  readonly tasks?: readonly Task[];
};

/**
 * A version mismatch is an expected outcome, not an exception: it means the
 * world moved while the user was deciding, and the caller's next step is to
 * re-simulate rather than to retry.
 */
export type CommitOutcome =
  | { readonly status: "COMMITTED"; readonly productionVersion: ProductionVersion }
  | {
      readonly status: "VERSION_MISMATCH";
      readonly expected: ProductionVersion;
      readonly actual: ProductionVersion;
    };

export interface ProductionRepository {
  /** The full snapshot the deterministic engine reads, or null if unknown. */
  loadState(productionId: EntityId): Promise<ProductionState | null>;

  /**
   * Replaces a production wholesale. This is the seed and reset path, not the
   * mutation path: it performs no version check and increments nothing.
   */
  save(state: ProductionState): Promise<void>;

  /**
   * Applies a mutation atomically and increments the production version by one
   * (INV-7). Either every write lands or none does.
   */
  commit(mutation: ProductionMutation): Promise<CommitOutcome>;
}

export interface ChangeRequestRepository {
  save(changeRequest: ChangeRequest): Promise<void>;
  findById(productionId: EntityId, changeRequestId: EntityId): Promise<ChangeRequest | null>;
}

export interface ProposalRepository {
  save(proposal: Proposal): Promise<void>;
  findById(productionId: EntityId, proposalId: EntityId): Promise<Proposal | null>;
  listByStatus(productionId: EntityId, status: ProposalStatus): Promise<Proposal[]>;
}

export interface ApprovalRepository {
  save(approval: Approval): Promise<void>;
  findById(productionId: EntityId, approvalId: EntityId): Promise<Approval | null>;
  /** The decision recorded for a proposal, or null while none has been made. */
  findByProposalId(productionId: EntityId, proposalId: EntityId): Promise<Approval | null>;
}

export interface AuditEventRepository {
  append(event: AuditEvent): Promise<void>;
  /** Newest first, because an operator asks "what just happened?" far more often. */
  list(productionId: EntityId, options?: { readonly limit?: number }): Promise<AuditEvent[]>;
}

export interface IdempotencyRepository {
  find(productionId: EntityId, key: IdempotencyKey): Promise<IdempotencyRecord | null>;
  save(productionId: EntityId, record: IdempotencyRecord): Promise<void>;
}

/**
 * The one consequential write (`apply_approved_proposal`, MCP.md §7) and
 * everything that must be true the instant it lands: the idempotency record
 * a replay needs, the proposal's terminal status, and the audit event that
 * makes the mutation legible. Bundled into one input so an adapter commits
 * all four together instead of the caller sequencing four separate calls
 * (code review finding #1, SEC-005, AUD-002).
 */
export type ApplyProposalCommit = {
  readonly mutation: ProductionMutation;
  readonly idempotencyRecord: IdempotencyRecord;
  /** The proposal as it should read after this commit (status already `APPLIED`). */
  readonly proposal: Proposal;
  readonly auditEvent: AuditEvent;
};

/**
 * Everything a use case needs from storage, passed as one object so a new port
 * does not ripple through every constructor.
 */
export type RepositorySet = {
  readonly productions: ProductionRepository;
  readonly changeRequests: ChangeRequestRepository;
  readonly proposals: ProposalRepository;
  readonly approvals: ApprovalRepository;
  readonly auditEvents: AuditEventRepository;
  readonly idempotency: IdempotencyRepository;

  /**
   * Commits `mutation` (INV-7's version check included) together with the
   * idempotency record, the proposal's next status, and its audit event as
   * one atomic unit: either the production changes and all three records
   * exist, or none of the four do. A version mismatch leaves every one of
   * them untouched, exactly like a plain `productions.commit` mismatch.
   *
   * A property-typed function, not method shorthand: every implementation is
   * an arrow-function field bound to its adapter instance, so it stays safe
   * to read out and pass around (`guardRepositories`, `repositorySetOf`)
   * without an unbound-`this` risk — which method shorthand would obscure.
   */
  readonly applyProposalTransaction: (commit: ApplyProposalCommit) => Promise<CommitOutcome>;
};
