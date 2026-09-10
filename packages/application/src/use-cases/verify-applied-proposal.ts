import type { AuditEvent, EntityId, Proposal } from "@pca/contracts";
import type { VerificationCheck } from "@pca/domain";
import {
  indexProduction,
  verifyAvailabilityHonoured,
  verifyInvariantsHold,
  verifyOperationsApplied,
} from "@pca/domain";

import type { Clock, IdFactory, RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Post-write verification (SPEC.md FR-8, MCP.md §8 `verify_applied_proposal`).
 *
 * Reads the production back and checks that every operation's postcondition
 * holds, that nobody unavailable is still scheduled, that the invariants hold,
 * and that the bookkeeping around the write is consistent with its effects.
 *
 * The bookkeeping checks are what notice the case TASK-108 documented: a crash
 * between the commit and the records that follow it leaves the effects applied
 * but the proposal still APPROVED and no apply audit. Verification reports
 * that as a named failure rather than letting it pass as "looks fine".
 *
 * The outcome is recorded either way. A failed verification is surfaced and
 * written down, not merely returned; a passed one is the "System verified
 * schedule" line the audit view shows.
 */

export type VerifyAppliedProposalInput = {
  readonly productionId: EntityId;
  readonly proposalId: EntityId;
  readonly correlationId?: string;
};

export type VerificationReport = {
  readonly success: boolean;
  readonly checks: VerificationCheck[];
  readonly proposal: Proposal;
};

export type VerifyAppliedProposal = (
  input: VerifyAppliedProposalInput,
) => Promise<UseCaseResult<VerificationReport>>;

export const createVerifyAppliedProposal = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): VerifyAppliedProposal => {
  const { repositories, clock, ids } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };

    const proposal = await repositories.proposals.findById(input.productionId, input.proposalId);
    if (proposal === null) {
      return fail(
        "ENTITY_NOT_FOUND",
        `Proposal ${input.proposalId} does not exist in production ${input.productionId}.`,
        {
          ...trace,
          actual: input.proposalId,
          nextStep: "Verify a proposal that has been applied.",
        },
      );
    }

    const state = await repositories.productions.loadState(input.productionId);
    if (state === null) {
      return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
        ...trace,
        actual: input.productionId,
        nextStep: "Call get_production with a known production ID.",
      });
    }

    const index = indexProduction(state);
    const applyAudit = (await repositories.auditEvents.list(input.productionId)).find(
      (event) => event.action === "PROPOSAL_APPLIED" && event.entityId === proposal.id,
    );

    const checks: VerificationCheck[] = [
      ...verifyOperationsApplied(index, proposal.operations),
      ...verifyAvailabilityHonoured(index, proposal.operations),
      verifyInvariantsHold(index),
      {
        name: "Production version advanced past the proposal's base",
        passed: state.production.version > proposal.baseProductionVersion,
        detail: `Base ${proposal.baseProductionVersion}, current ${state.production.version}.`,
      },
      {
        name: "Proposal is marked APPLIED",
        passed: proposal.status === "APPLIED",
        detail:
          proposal.status === "APPLIED"
            ? "Status is APPLIED."
            : `Status is ${proposal.status}. If the operation checks pass, the write landed but its bookkeeping did not.`,
      },
      {
        name: "Apply was audited",
        passed: applyAudit !== undefined,
        detail:
          applyAudit === undefined
            ? "No PROPOSAL_APPLIED audit event exists for this proposal."
            : `Audited at ${applyAudit.createdAt}.`,
      },
    ];

    const success = checks.every((entry) => entry.passed);
    const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.name);

    const audit: AuditEvent = {
      id: ids.next("AE"),
      productionId: input.productionId,
      actorType: "SYSTEM",
      action: success ? "PROPOSAL_VERIFIED" : "PROPOSAL_VERIFICATION_FAILED",
      entityType: "PROPOSAL",
      entityId: proposal.id,
      ...trace,
      metadata: {
        checkCount: checks.length,
        failedChecks: failed,
        productionVersion: state.production.version,
      },
      createdAt: clock.now(),
    };
    await repositories.auditEvents.append(audit);

    return succeed({ success, checks, proposal });
  };
};
