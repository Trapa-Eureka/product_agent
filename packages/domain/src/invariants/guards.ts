import type {
  Approval,
  IdempotencyKey,
  Proposal,
  ProductionVersion,
  ProposalDigest,
} from "@pca/contracts";

import type { GuardResult } from "./types";
import { firstFailure, guardFailed, guardPassed } from "./types";

/**
 * Guards on the approval and apply path (DOMAIN.md INV-5 to INV-8).
 *
 * These are the rules that make a single high-level write tool safe to expose
 * to an agent. Each one is a pure function, so the safety story is testable
 * without a database, a queue, or a model.
 */

/** INV-5: no consequential operation may be applied without a valid approval. */
export const requireApproval = (input: {
  readonly proposal: Proposal;
  readonly approval: Approval | null;
}): GuardResult => {
  const { proposal, approval } = input;

  if (approval === null) {
    return guardFailed(
      "INV-5",
      "APPROVAL_REQUIRED",
      `Proposal ${proposal.id} has no approval record, so nothing may be written.`,
      { nextStep: "Present the proposal for human approval, then retry with the approval ID." },
    );
  }

  if (approval.proposalId !== proposal.id) {
    return guardFailed(
      "INV-5",
      "APPROVAL_MISMATCH",
      `Approval ${approval.id} approves proposal ${approval.proposalId}, not ${proposal.id}.`,
      {
        expected: proposal.id,
        actual: approval.proposalId,
        nextStep: "Supply the approval that belongs to this proposal.",
      },
    );
  }

  if (approval.decision !== "APPROVE") {
    return guardFailed(
      "INV-5",
      "APPROVAL_REQUIRED",
      `Proposal ${proposal.id} was rejected by ${approval.approvedBy}; a rejection never authorises a write.`,
      {
        expected: "APPROVE",
        actual: approval.decision,
        nextStep: "Create a new proposal if the change is still wanted.",
      },
    );
  }

  return guardPassed();
};

/**
 * INV-6: an approval is valid only for the exact proposal digest and the
 * expected production version.
 *
 * This is what stops "approve, then edit the plan, then apply". The digest binds
 * the approval to the operations; the version binds it to the world those
 * operations were simulated against.
 */
export const checkApprovalFreshness = (input: {
  readonly proposal: Proposal;
  readonly approval: Approval;
  readonly currentProductionVersion: ProductionVersion;
  readonly recomputedDigest: ProposalDigest;
}): GuardResult => {
  const { proposal, approval, currentProductionVersion, recomputedDigest } = input;

  if (recomputedDigest !== proposal.digest) {
    return guardFailed(
      "INV-6",
      "PROPOSAL_INVALID",
      `Proposal ${proposal.id} no longer hashes to its stored digest, so its operations changed after it was created.`,
      {
        expected: proposal.digest,
        actual: recomputedDigest,
        nextStep: "Discard this proposal and re-run simulation.",
      },
    );
  }

  if (approval.proposalDigest !== proposal.digest) {
    return guardFailed(
      "INV-6",
      "APPROVAL_MISMATCH",
      `Approval ${approval.id} was given for a different version of proposal ${proposal.id}.`,
      {
        expected: proposal.digest,
        actual: approval.proposalDigest,
        nextStep: "Re-present the current proposal for approval.",
      },
    );
  }

  if (approval.productionVersion !== proposal.baseProductionVersion) {
    return guardFailed(
      "INV-6",
      "APPROVAL_MISMATCH",
      `Approval ${approval.id} was given against production version ${approval.productionVersion}, but proposal ${proposal.id} was simulated against ${proposal.baseProductionVersion}.`,
      {
        expected: String(proposal.baseProductionVersion),
        actual: String(approval.productionVersion),
        nextStep: "Re-simulate and re-approve against the current production version.",
      },
    );
  }

  if (proposal.baseProductionVersion !== currentProductionVersion) {
    return guardFailed(
      "INV-6",
      "PRODUCTION_VERSION_MISMATCH",
      `Proposal ${proposal.id} was simulated against version ${proposal.baseProductionVersion} but the production is now at version ${currentProductionVersion}.`,
      {
        expected: String(proposal.baseProductionVersion),
        actual: String(currentProductionVersion),
        nextStep: "Reload production state and re-run simulation before requesting approval.",
      },
    );
  }

  return guardPassed();
};

/** A proposal must have passed validation and still be applicable. */
export const checkProposalApplicable = (proposal: Proposal): GuardResult => {
  if (proposal.validationStatus !== "VALID") {
    return guardFailed(
      "INV-5",
      "PROPOSAL_INVALID",
      `Proposal ${proposal.id} failed validation and cannot be applied.`,
      {
        expected: "VALID",
        actual: proposal.validationStatus,
        nextStep: "Resolve the reported conflicts and create a new proposal.",
      },
    );
  }

  const applicableStatuses = new Set<Proposal["status"]>(["AWAITING_APPROVAL", "APPROVED"]);
  if (!applicableStatuses.has(proposal.status)) {
    return guardFailed(
      "INV-5",
      "PROPOSAL_INVALID",
      `Proposal ${proposal.id} is ${proposal.status} and is not awaiting application.`,
      {
        expected: "AWAITING_APPROVAL or APPROVED",
        actual: proposal.status,
        nextStep:
          proposal.status === "APPLIED"
            ? "Read the proposal to see the operations that were already applied."
            : "Create a new proposal.",
      },
    );
  }

  return guardPassed();
};

/**
 * The complete pre-write gate.
 *
 * Callers run this one function rather than remembering four checks and their
 * order, which is how an approval boundary quietly develops a hole.
 */
export const checkWriteAllowed = (input: {
  readonly proposal: Proposal;
  readonly approval: Approval | null;
  readonly currentProductionVersion: ProductionVersion;
  readonly recomputedDigest: ProposalDigest;
}): GuardResult => {
  const approvalPresent = requireApproval(input);
  if (!approvalPresent.ok) {
    return approvalPresent;
  }
  // requireApproval has established that the approval is non-null.
  const approval = input.approval as Approval;

  return firstFailure([
    checkProposalApplicable(input.proposal),
    checkApprovalFreshness({
      proposal: input.proposal,
      approval,
      currentProductionVersion: input.currentProductionVersion,
      recomputedDigest: input.recomputedDigest,
    }),
  ]);
};

/** INV-7: a successful consequential mutation increments the production version by one. */
export const nextProductionVersion = (current: ProductionVersion): ProductionVersion => current + 1;

export const checkVersionIncremented = (input: {
  readonly before: ProductionVersion;
  readonly after: ProductionVersion;
}): GuardResult => {
  const expected = nextProductionVersion(input.before);
  if (input.after !== expected) {
    return guardFailed(
      "INV-7",
      "INTERNAL_ERROR",
      `A consequential mutation must increment the production version exactly once.`,
      {
        expected: String(expected),
        actual: String(input.after),
        nextStep: "Treat the write as failed and re-read production state before retrying.",
      },
    );
  }
  return guardPassed();
};

/**
 * INV-8: replaying an idempotency key must not apply the work twice.
 *
 * A replay of the same proposal is a success that changes nothing. The same key
 * arriving for different work is a conflict, because honouring it would either
 * duplicate the first result or silently discard the second.
 */
export type IdempotencyRecord = {
  readonly key: IdempotencyKey;
  readonly proposalId: string;
  readonly proposalDigest: ProposalDigest;
  readonly productionVersionAfter: ProductionVersion;
  /** What the first run touched, so a replay can answer without re-deriving it. */
  readonly affectedEntityIds: readonly string[];
};

export type IdempotencyOutcome =
  | { readonly kind: "FIRST_RUN" }
  | { readonly kind: "REPLAY"; readonly record: IdempotencyRecord }
  | { readonly kind: "CONFLICT"; readonly guard: GuardResult };

export const classifyIdempotency = (input: {
  readonly key: IdempotencyKey;
  readonly proposal: Proposal;
  readonly existing: IdempotencyRecord | null;
}): IdempotencyOutcome => {
  const { key, proposal, existing } = input;

  if (existing === null) {
    return { kind: "FIRST_RUN" };
  }

  if (existing.proposalId === proposal.id && existing.proposalDigest === proposal.digest) {
    return { kind: "REPLAY", record: existing };
  }

  return {
    kind: "CONFLICT",
    guard: guardFailed(
      "INV-8",
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key "${key}" was already used for proposal ${existing.proposalId}.`,
      {
        expected: existing.proposalId,
        actual: proposal.id,
        nextStep: "Retry with an idempotency key derived from this proposal and its digest.",
      },
    ),
  };
};

/** The deterministic apply key is defined once, in contracts, because the console derives it too (TASK-937). */
export { idempotencyKeyForProposal } from "@pca/contracts";
