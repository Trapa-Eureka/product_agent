import type { Approval, ApprovalDecision, AuditEvent, EntityId, Proposal } from "@pca/contracts";
import {
  checkProposalApplicable,
  computeProposalDigest,
  indexProduction,
  simulateProposal,
} from "@pca/domain";

import type { Clock, IdFactory, RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * The human decision (SPEC.md FR-6, DOMAIN.md INV-5/INV-6).
 *
 * Creates the approval record that the apply path will demand. It is bound to
 * the proposal's digest and base version, not merely to its ID, so a proposal
 * edited or a world moved after this moment invalidates the approval instead
 * of silently widening it.
 *
 * Approving is strict: the proposal must be valid, un-tampered, and fresh, and
 * it is re-simulated once more against the current production before the
 * record is written. Rejecting is lenient: a coordinator may always say no.
 *
 * A decision is final. Repeating the same decision returns the existing
 * record; contradicting it is refused. A rejected proposal is not revived; a
 * new one is made. Finality is enforced by the store, not by this read-then-
 * write: `recordProposalDecision` (TASK-902) records the approval, the decided
 * status, and the audit event atomically and only if no decision exists yet,
 * so two concurrent callers cannot both succeed with opposite answers.
 */

export type DecideProposalInput = {
  readonly productionId: EntityId;
  readonly proposalId: EntityId;
  readonly decision: ApprovalDecision;
  readonly decidedBy: string;
  readonly correlationId?: string;
};

export type ProposalDecision = {
  readonly approval: Approval;
  readonly proposal: Proposal;
  /** True when an identical decision already existed and nothing new was written. */
  readonly alreadyDecided: boolean;
};

export type DecideProposal = (
  input: DecideProposalInput,
) => Promise<UseCaseResult<ProposalDecision>>;

export const createDecideProposal = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): DecideProposal => {
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
          nextStep: "Create a proposal with create_proposal first.",
        },
      );
    }

    // A decision is final. Repeating it is a no-op; contradicting it is refused.
    // Checked here so an obviously settled proposal skips re-simulation, and
    // checked again atomically at the write (TASK-902): two callers can both
    // pass this read, but only one can pass `recordProposalDecision`.
    const alreadyDecided = (existing: Approval): UseCaseResult<ProposalDecision> => {
      if (existing.decision === input.decision) {
        return succeed({ approval: existing, proposal, alreadyDecided: true });
      }
      return fail(
        "CONSTRAINT_VIOLATION",
        `Proposal ${proposal.id} was already ${existing.decision === "APPROVE" ? "approved" : "rejected"} by ${existing.approvedBy}; a decision is final.`,
        {
          ...trace,
          expected: existing.decision,
          actual: input.decision,
          nextStep: "Create a new proposal if the change is still wanted.",
        },
      );
    };

    const existing = await repositories.approvals.findByProposalId(input.productionId, proposal.id);
    if (existing !== null) {
      return alreadyDecided(existing);
    }

    const recomputed = computeProposalDigest(proposal);
    if (recomputed !== proposal.digest) {
      return fail(
        "PROPOSAL_INVALID",
        `Proposal ${proposal.id} no longer hashes to its stored digest, so its operations changed after it was created.`,
        {
          ...trace,
          expected: proposal.digest,
          actual: recomputed,
          nextStep: "Discard this proposal and create a new one from a fresh simulation.",
        },
      );
    }

    if (input.decision === "APPROVE") {
      const applicable = checkProposalApplicable(proposal);
      if (!applicable.ok) {
        return { ok: false, error: { ...applicable.error, ...trace } };
      }

      const state = await repositories.productions.loadState(input.productionId);
      if (state === null) {
        return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
          ...trace,
          actual: input.productionId,
          nextStep: "Call get_production with a known production ID.",
        });
      }

      if (state.production.version !== proposal.baseProductionVersion) {
        return fail(
          "PRODUCTION_VERSION_MISMATCH",
          `Proposal ${proposal.id} was simulated against version ${proposal.baseProductionVersion} but the production is now at version ${state.production.version}.`,
          {
            ...trace,
            expected: String(proposal.baseProductionVersion),
            actual: String(state.production.version),
            nextStep: "Reload production state and re-run simulation before requesting approval.",
          },
        );
      }

      const outcome = simulateProposal(indexProduction(state), proposal.operations);
      if (!outcome.valid) {
        return fail(
          "PROPOSAL_INVALID",
          `Proposal ${proposal.id} no longer simulates cleanly: ${outcome.conflicts[0]?.detail ?? "unknown conflict"}`,
          { ...trace, nextStep: "Re-run simulation and create a new proposal." },
        );
      }
    }

    const createdAt = clock.now();
    const approval: Approval = {
      id: ids.next("A"),
      productionId: input.productionId,
      proposalId: proposal.id,
      proposalDigest: proposal.digest,
      productionVersion: proposal.baseProductionVersion,
      approvedBy: input.decidedBy,
      decision: input.decision,
      createdAt,
    };

    const decided: Proposal = {
      ...proposal,
      status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
    };

    const audit: AuditEvent = {
      id: ids.next("AE"),
      productionId: input.productionId,
      actorType: "USER",
      actorId: input.decidedBy,
      action: input.decision === "APPROVE" ? "PROPOSAL_APPROVED" : "PROPOSAL_REJECTED",
      entityType: "PROPOSAL",
      entityId: proposal.id,
      ...trace,
      metadata: {
        approvalId: approval.id,
        proposalDigest: approval.proposalDigest,
        productionVersion: approval.productionVersion,
      },
      createdAt,
    };

    const outcome = await repositories.recordProposalDecision({
      approval,
      proposal: decided,
      auditEvent: audit,
    });
    if (outcome.status === "ALREADY_DECIDED") {
      // Lost the race to another decision between the read above and this
      // write. Nothing of ours was written; answer from the record that won.
      return alreadyDecided(outcome.approval);
    }

    return succeed({ approval, proposal: decided, alreadyDecided: false });
  };
};
