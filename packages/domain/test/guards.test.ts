import { describe, expect, it } from "vitest";

import type { Approval } from "@pca/contracts";

import { computeProposalDigest } from "../src/digest";
import {
  checkApprovalFreshness,
  checkProposalApplicable,
  checkVersionIncremented,
  checkWriteAllowed,
  classifyIdempotency,
  idempotencyKeyForProposal,
  nextProductionVersion,
  requireApproval,
} from "../src/invariants/guards";
import { aProposal } from "./builders";

const digestFor = (proposal: ReturnType<typeof aProposal>): string =>
  computeProposalDigest({
    productionId: proposal.productionId,
    changeRequestId: proposal.changeRequestId,
    baseProductionVersion: proposal.baseProductionVersion,
    operations: proposal.operations,
  });

/** A proposal whose stored digest genuinely matches its operations. */
const aSealedProposal = (overrides: Parameters<typeof aProposal>[0] = {}) => {
  const draft = aProposal(overrides);
  return { ...draft, digest: digestFor(draft) };
};

const anApproval = (
  proposal: ReturnType<typeof aProposal>,
  overrides: Partial<Approval> = {},
): Approval => ({
  id: "A-77",
  productionId: proposal.productionId,
  proposalId: proposal.id,
  proposalDigest: proposal.digest,
  productionVersion: proposal.baseProductionVersion,
  approvedBy: "coordinator@example.test",
  decision: "APPROVE",
  createdAt: "2026-09-10T11:05:00.000Z",
  ...overrides,
});

describe("INV-5 approval before write", () => {
  it("refuses a write when no approval exists", () => {
    const proposal = aSealedProposal();
    const result = requireApproval({ proposal, approval: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invariant).toBe("INV-5");
    expect(result.error.code).toBe("APPROVAL_REQUIRED");
    expect(result.error.nextStep).toContain("human approval");
  });

  it("refuses an approval that belongs to a different proposal", () => {
    const proposal = aSealedProposal();
    const result = requireApproval({
      proposal,
      approval: anApproval(proposal, { proposalId: "P-999" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("APPROVAL_MISMATCH");
    expect(result.error.expected).toBe("P-104");
    expect(result.error.actual).toBe("P-999");
  });

  it("treats a rejection as authorising nothing", () => {
    const proposal = aSealedProposal();
    const result = requireApproval({
      proposal,
      approval: anApproval(proposal, { decision: "REJECT" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("accepts a matching approval", () => {
    const proposal = aSealedProposal();
    expect(requireApproval({ proposal, approval: anApproval(proposal) }).ok).toBe(true);
  });
});

describe("proposal applicability", () => {
  it("refuses to apply a proposal that failed validation", () => {
    const result = checkProposalApplicable(aSealedProposal({ validationStatus: "INVALID" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROPOSAL_INVALID");
  });

  it("refuses to apply a proposal that was already applied", () => {
    const result = checkProposalApplicable(aSealedProposal({ status: "APPLIED" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.actual).toBe("APPLIED");
    expect(result.error.nextStep).toContain("already applied");
  });
});

describe("INV-6 approval freshness", () => {
  it("accepts an approval bound to the current digest and version", () => {
    const proposal = aSealedProposal();
    const result = checkApprovalFreshness({
      proposal,
      approval: anApproval(proposal),
      currentProductionVersion: proposal.baseProductionVersion,
      recomputedDigest: proposal.digest,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses when the proposal's operations changed after it was created", () => {
    const proposal = aSealedProposal();
    const tampered = {
      ...proposal,
      operations: [
        {
          type: "MOVE_SCENES" as const,
          sceneIds: ["S07", "S12"],
          fromShootDayId: "SD-2026-09-18",
          toShootDayId: "SD-2026-09-21",
        },
      ],
    };

    const result = checkApprovalFreshness({
      proposal: tampered,
      approval: anApproval(tampered),
      currentProductionVersion: tampered.baseProductionVersion,
      recomputedDigest: digestFor(tampered),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invariant).toBe("INV-6");
    expect(result.error.code).toBe("PROPOSAL_INVALID");
  });

  it("refuses an approval given for an earlier version of the proposal", () => {
    const proposal = aSealedProposal();
    const result = checkApprovalFreshness({
      proposal,
      approval: anApproval(proposal, { proposalDigest: "c".repeat(64) }),
      currentProductionVersion: proposal.baseProductionVersion,
      recomputedDigest: proposal.digest,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("APPROVAL_MISMATCH");
  });

  it("refuses when production state moved on after simulation", () => {
    const proposal = aSealedProposal();
    const result = checkApprovalFreshness({
      proposal,
      approval: anApproval(proposal),
      currentProductionVersion: proposal.baseProductionVersion + 1,
      recomputedDigest: proposal.digest,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PRODUCTION_VERSION_MISMATCH");
    expect(result.error.expected).toBe("12");
    expect(result.error.actual).toBe("13");
    expect(result.error.nextStep).toContain("re-run simulation");
  });
});

describe("checkWriteAllowed", () => {
  it("allows a fully bound, valid, fresh apply", () => {
    const proposal = aSealedProposal();
    const result = checkWriteAllowed({
      proposal,
      approval: anApproval(proposal),
      currentProductionVersion: proposal.baseProductionVersion,
      recomputedDigest: proposal.digest,
    });

    expect(result).toEqual({ ok: true });
  });

  it("reports the missing approval before anything else", () => {
    const proposal = aSealedProposal({ validationStatus: "INVALID" });
    const result = checkWriteAllowed({
      proposal,
      approval: null,
      currentProductionVersion: 99,
      recomputedDigest: proposal.digest,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("refuses a stale apply even when every other check passes", () => {
    const proposal = aSealedProposal();
    const result = checkWriteAllowed({
      proposal,
      approval: anApproval(proposal),
      currentProductionVersion: 13,
      recomputedDigest: proposal.digest,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PRODUCTION_VERSION_MISMATCH");
  });
});

describe("INV-7 post-write versioning", () => {
  it("increments by exactly one", () => {
    expect(nextProductionVersion(12)).toBe(13);
  });

  it("accepts a single increment", () => {
    expect(checkVersionIncremented({ before: 12, after: 13 }).ok).toBe(true);
  });

  it.each([
    ["an unchanged version", 12],
    ["a double increment", 14],
    ["a decrement", 11],
  ])("rejects %s", (_label, after) => {
    const result = checkVersionIncremented({ before: 12, after });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invariant).toBe("INV-7");
    expect(result.error.expected).toBe("13");
  });
});

describe("INV-8 idempotency", () => {
  it("treats an unseen key as a first run", () => {
    const proposal = aSealedProposal();
    expect(classifyIdempotency({ key: "apply-1", proposal, existing: null })).toEqual({
      kind: "FIRST_RUN",
    });
  });

  it("treats a repeat of the same proposal as a replay rather than new work", () => {
    const proposal = aSealedProposal();
    const outcome = classifyIdempotency({
      key: "apply-1",
      proposal,
      existing: {
        key: "apply-1",
        proposalId: proposal.id,
        proposalDigest: proposal.digest,
        productionVersionAfter: 13,
        affectedEntityIds: [],
      },
    });

    expect(outcome.kind).toBe("REPLAY");
    if (outcome.kind !== "REPLAY") return;
    expect(outcome.record.productionVersionAfter).toBe(13);
  });

  it("refuses to reuse a key for different work", () => {
    const proposal = aSealedProposal();
    const outcome = classifyIdempotency({
      key: "apply-1",
      proposal,
      existing: {
        key: "apply-1",
        proposalId: "P-999",
        proposalDigest: "d".repeat(64),
        productionVersionAfter: 13,
        affectedEntityIds: [],
      },
    });

    expect(outcome.kind).toBe("CONFLICT");
    if (outcome.kind !== "CONFLICT") return;
    expect(outcome.guard.ok).toBe(false);
    if (outcome.guard.ok) return;
    expect(outcome.guard.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("refuses a key reused after the proposal's operations changed", () => {
    const proposal = aSealedProposal();
    const outcome = classifyIdempotency({
      key: "apply-1",
      proposal,
      existing: {
        key: "apply-1",
        proposalId: proposal.id,
        proposalDigest: "e".repeat(64),
        productionVersionAfter: 13,
        affectedEntityIds: [],
      },
    });

    expect(outcome.kind).toBe("CONFLICT");
  });

  it("derives a key that is stable for a proposal and differs between proposals", () => {
    const first = aSealedProposal();
    const second = aSealedProposal({ changeRequestId: "CR-002" });

    expect(idempotencyKeyForProposal(first)).toBe(idempotencyKeyForProposal(first));
    expect(idempotencyKeyForProposal(first)).not.toBe(idempotencyKeyForProposal(second));
  });
});
