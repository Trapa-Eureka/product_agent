import type {
  AuditEvent,
  EntityId,
  IdempotencyKey,
  ProductionVersion,
  Proposal,
  ProposalStatus,
} from "@pca/contracts";
import { applyApprovedProposalInputSchema } from "@pca/contracts";
import type { ProductionState } from "@pca/domain";
import {
  applyOperations,
  checkWriteAllowed,
  classifyIdempotency,
  computeProposalDigest,
} from "@pca/domain";

import type { Clock, IdFactory, ProductionMutation, RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * The one consequential write (MCP.md §7 `apply_approved_proposal`).
 *
 * Everything before this point was a read or a record. This is where the
 * production changes, and it changes only through the same applyOperations
 * that simulation ran, now handed real IDs. What the coordinator approved is
 * what happens.
 *
 * Order of checks matters and is fixed here rather than left to callers:
 *
 * 1. idempotency: a replay answers from its record and touches nothing;
 * 2. the pre-write gate (INV-5, INV-6): approval present, matching, fresh;
 *    proposal valid and un-tampered; production at the expected version;
 * 3. apply to a copy; any operation that cannot apply fails the whole thing;
 * 4. commit the mutation, the idempotency record, the proposal's APPLIED
 *    status, and its audit event as one atomic write (INV-7's version check
 *    included) via `repositories.applyProposalTransaction` — TASK-901 (code
 *    review #1, SEC-005, AUD-002): every adapter guarantees all four commit
 *    together or none do, so a crash mid-write can no longer separate the
 *    mutation from its bookkeeping.
 */

export type ApplyApprovedProposalInput = {
  readonly productionId: EntityId;
  readonly proposalId: EntityId;
  readonly approvalId: EntityId;
  readonly expectedProductionVersion: ProductionVersion;
  readonly idempotencyKey: IdempotencyKey;
  readonly appliedBy?: string;
  readonly correlationId?: string;
};

export type ApplyResult = {
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly productionVersion: ProductionVersion;
  readonly affectedEntityIds: EntityId[];
  readonly proposalStatus: ProposalStatus;
};

export type ApplyApprovedProposal = (
  input: ApplyApprovedProposalInput,
) => Promise<UseCaseResult<ApplyResult>>;

const changedIds = <T extends { id: EntityId }>(
  before: readonly T[],
  after: readonly T[],
): { ids: EntityId[]; records: T[] } => {
  const previous = new Map(before.map((record) => [record.id, JSON.stringify(record)]));
  const records = after.filter((record) => previous.get(record.id) !== JSON.stringify(record));
  return { ids: records.map((record) => record.id), records };
};

/** Only what actually changed is written, so the commit is as small as the effect. */
const mutationFor = (
  productionId: EntityId,
  expectedVersion: ProductionVersion,
  before: ProductionState,
  after: ProductionState,
): { mutation: ProductionMutation; affectedEntityIds: EntityId[] } => {
  const castMembers = changedIds(before.castMembers, after.castMembers);
  const locations = changedIds(before.locations, after.locations);
  const scenes = changedIds(before.scenes, after.scenes);
  const requirements = changedIds(before.requirements, after.requirements);
  const shootDays = changedIds(before.shootDays, after.shootDays);
  const callSheets = changedIds(before.callSheets, after.callSheets);
  const tasks = changedIds(before.tasks, after.tasks);

  return {
    mutation: {
      productionId,
      expectedVersion,
      castMembers: castMembers.records,
      locations: locations.records,
      scenes: scenes.records,
      requirements: requirements.records,
      shootDays: shootDays.records,
      callSheets: callSheets.records,
      tasks: tasks.records,
    },
    affectedEntityIds: [
      ...castMembers.ids,
      ...locations.ids,
      ...scenes.ids,
      ...requirements.ids,
      ...shootDays.ids,
      ...callSheets.ids,
      ...tasks.ids,
    ].sort((left, right) => left.localeCompare(right)),
  };
};

export const createApplyApprovedProposal = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): ApplyApprovedProposal => {
  const { repositories, clock, ids } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };

    const parsed = applyApprovedProposalInputSchema.safeParse({
      productionId: input.productionId,
      proposalId: input.proposalId,
      approvalId: input.approvalId,
      expectedProductionVersion: input.expectedProductionVersion,
      idempotencyKey: input.idempotencyKey,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        "INVALID_INPUT",
        `The request is malformed: ${issue?.message ?? "unknown issue"}.`,
        {
          ...trace,
          actual: issue?.path.join(".") ?? "<root>",
          nextStep:
            "Supply proposal ID, approval ID, expected production version, and an idempotency key.",
        },
      );
    }
    const { productionId, proposalId, approvalId, expectedProductionVersion, idempotencyKey } =
      parsed.data;

    const proposal = await repositories.proposals.findById(productionId, proposalId);
    if (proposal === null) {
      return fail(
        "ENTITY_NOT_FOUND",
        `Proposal ${proposalId} does not exist in production ${productionId}.`,
        {
          ...trace,
          actual: proposalId,
          nextStep: "Create and approve a proposal first.",
        },
      );
    }

    const existingRecord = await repositories.idempotency.find(productionId, idempotencyKey);
    const idempotency = classifyIdempotency({
      key: idempotencyKey,
      proposal,
      existing: existingRecord,
    });
    if (idempotency.kind === "REPLAY") {
      return succeed({
        applied: false,
        replayed: true,
        productionVersion: idempotency.record.productionVersionAfter,
        affectedEntityIds: [...idempotency.record.affectedEntityIds],
        proposalStatus: proposal.status,
      });
    }
    if (idempotency.kind === "CONFLICT") {
      return idempotency.guard.ok
        ? fail("INTERNAL_ERROR", "Idempotency conflict without a guard failure.", trace)
        : { ok: false, error: { ...idempotency.guard.error, ...trace } };
    }

    const approval = await repositories.approvals.findById(productionId, approvalId);
    if (approval === null) {
      return fail(
        "APPROVAL_REQUIRED",
        `Approval ${approvalId} does not exist in production ${productionId}.`,
        {
          ...trace,
          actual: approvalId,
          nextStep: "Present the proposal for human approval, then retry with the approval ID.",
        },
      );
    }

    const state = await repositories.productions.loadState(productionId);
    if (state === null) {
      return fail("ENTITY_NOT_FOUND", `Production ${productionId} does not exist.`, {
        ...trace,
        actual: productionId,
        nextStep: "Call get_production with a known production ID.",
      });
    }

    if (state.production.version !== expectedProductionVersion) {
      return fail(
        "PRODUCTION_VERSION_MISMATCH",
        `You expected production ${productionId} at version ${expectedProductionVersion} but it is at version ${state.production.version}.`,
        {
          ...trace,
          expected: String(expectedProductionVersion),
          actual: String(state.production.version),
          nextStep:
            "Reload production state; if the proposal is stale, re-run simulation and re-approve.",
        },
      );
    }

    const gate = checkWriteAllowed({
      proposal,
      approval,
      currentProductionVersion: state.production.version,
      recomputedDigest: computeProposalDigest(proposal),
    });
    if (!gate.ok) {
      return { ok: false, error: { ...gate.error, ...trace } };
    }

    const application = applyOperations(state, proposal.operations, (prefix) => ids.next(prefix));
    const appliedAt = clock.now();

    if (application.conflicts.length > 0) {
      const failed: Proposal = { ...proposal, status: "FAILED", conflicts: application.conflicts };
      await repositories.proposals.save(failed);
      await repositories.auditEvents.append(
        auditEvent(ids, productionId, proposal.id, "PROPOSAL_APPLY_FAILED", appliedAt, input, {
          approvalId: approval.id,
          conflicts: application.conflicts,
        }),
      );
      return fail(
        "PROPOSAL_INVALID",
        `Proposal ${proposal.id} could not be applied: ${application.conflicts[0]?.detail ?? "unknown conflict"}`,
        {
          ...trace,
          nextStep: "Re-run simulation against the current production and create a new proposal.",
        },
      );
    }

    const { mutation, affectedEntityIds } = mutationFor(
      productionId,
      state.production.version,
      state,
      application.state,
    );

    // The idempotency record and audit event both need the post-commit
    // version, but the commit is what produces it. `outcome.productionVersion`
    // is only known once COMMITTED, so both are built from `mutation` and
    // filled in with that version right before the single atomic call below.
    const applied: Proposal = { ...proposal, status: "APPLIED" };
    const outcome = await repositories.applyProposalTransaction({
      mutation,
      proposal: applied,
      idempotencyRecord: {
        key: idempotencyKey,
        proposalId: proposal.id,
        proposalDigest: proposal.digest,
        productionVersionAfter: mutation.expectedVersion + 1,
        affectedEntityIds,
      },
      auditEvent: auditEvent(ids, productionId, proposal.id, "PROPOSAL_APPLIED", appliedAt, input, {
        approvalId: approval.id,
        productionVersionBefore: state.production.version,
        productionVersionAfter: mutation.expectedVersion + 1,
        operationCount: application.applied.length,
        skippedOperationCount: application.skipped.length,
        affectedEntityIds,
        idempotencyKey,
      }),
    });
    if (outcome.status === "VERSION_MISMATCH") {
      return fail(
        "PRODUCTION_VERSION_MISMATCH",
        `Production ${productionId} moved from version ${outcome.expected} to ${outcome.actual} while the proposal was being applied.`,
        {
          ...trace,
          expected: String(outcome.expected),
          actual: String(outcome.actual),
          nextStep: "Reload production state, re-run simulation, and re-approve.",
        },
      );
    }

    return succeed({
      applied: true,
      replayed: false,
      productionVersion: outcome.productionVersion,
      affectedEntityIds,
      proposalStatus: applied.status,
    });
  };
};

const auditEvent = (
  ids: IdFactory,
  productionId: EntityId,
  proposalId: EntityId,
  action: "PROPOSAL_APPLIED" | "PROPOSAL_APPLY_FAILED",
  createdAt: string,
  input: ApplyApprovedProposalInput,
  metadata: Record<string, unknown>,
): AuditEvent => ({
  id: ids.next("AE"),
  productionId,
  actorType: "SYSTEM",
  ...(input.appliedBy === undefined ? {} : { actorId: input.appliedBy }),
  action,
  entityType: "PROPOSAL",
  entityId: proposalId,
  ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  metadata,
  createdAt,
});
