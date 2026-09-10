import { beforeEach, describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import { checkWriteAllowed, computeProposalDigest } from "@pca/domain";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds, withCastUnavailable } from "@pca/test-support";

import {
  createCreateProposal,
  createDecideProposal,
  createSubmitChangeRequest,
  type CreateProposal,
  type DecideProposal,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const NOW = "2026-09-10T11:04:00.000Z";

const moveBoth: Extract<ProposedOperation, { type: "MOVE_SCENES" }> = {
  type: "MOVE_SCENES",
  sceneIds: [scenes.s07, scenes.s12],
  fromShootDayId: shootDays.friday,
  toShootDayId: shootDays.monday,
};

const golden1Remedy: ProposedOperation[] = [
  moveBoth,
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
];

describe("proposal lifecycle: create, then decide", () => {
  let store: MemoryStore;
  let create: CreateProposal;
  let decide: DecideProposal;

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(
      withCastUnavailable(createDemoMovie(), cast.sarah, onDay(DEMO_MOVIE_DATES.friday)),
    );
    const ids = sequentialIds();
    const clock = fixedClock(NOW);
    const submit = createSubmitChangeRequest({ repositories: store, clock, ids });
    await submit({
      productionId: DEMO,
      rawText: "Sarah cannot shoot Friday.",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: cast.sarah,
        unavailable: onDay(DEMO_MOVIE_DATES.friday),
      },
      createdBy: "coordinator@example.test",
    });
    create = createCreateProposal({ repositories: store, clock, ids });
    decide = createDecideProposal({ repositories: store, clock, ids });
  });

  const proposeGolden1 = () =>
    create({
      productionId: DEMO,
      changeRequestId: "CR-1",
      baseProductionVersion: 1,
      operations: golden1Remedy,
      summary: "Move Scene 07 and Scene 12 from Fri Sep 18 to Mon Sep 21.",
      proposedBy: "agent",
      correlationId: "corr-1",
    });

  describe("createProposal", () => {
    it("seals a valid proposal awaiting approval, with its digest and simulation verdict", async () => {
      const result = await proposeGolden1();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const proposal = result.value;
      expect(proposal).toMatchObject({
        id: "P-1",
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        validationStatus: "VALID",
        status: "AWAITING_APPROVAL",
        conflicts: [],
        createdAt: NOW,
      });
      expect(proposal.digest).toBe(computeProposalDigest(proposal));
      expect(proposal.warnings).toContain("John is required on 2026-09-21 for Scene 07.");
      expect(proposal.impacts.length).toBeGreaterThan(0);
      expect(await store.proposals.findById(DEMO, "P-1")).toEqual(proposal);
    });

    it("writes the 'agent proposed' audit line", async () => {
      await proposeGolden1();
      const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
      expect(event).toMatchObject({
        actorType: "AGENT",
        actorId: "agent",
        action: "PROPOSAL_CREATED",
        entityType: "PROPOSAL",
        entityId: "P-1",
        correlationId: "corr-1",
      });
      expect(event?.metadata).toMatchObject({ validationStatus: "VALID", operationCount: 3 });
    });

    it("persists an invalid proposal as a draft that shows why, rather than hiding it", async () => {
      const result = await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: [{ ...moveBoth, sceneIds: [scenes.s07] }],
        summary: "Move only Scene 07.",
        proposedBy: "agent",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("DRAFT");
      expect(result.value.validationStatus).toBe("INVALID");
      expect(result.value.conflicts[0]?.entityId).toBe(scenes.s12);
    });

    it("refuses a stale base version and persists nothing", async () => {
      await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });
      const result = await proposeGolden1();

      expect(!result.ok && result.error.code).toBe("PRODUCTION_VERSION_MISMATCH");
      expect(await store.proposals.listByStatus(DEMO, "AWAITING_APPROVAL")).toEqual([]);
    });

    it("refuses a change request this production does not have", async () => {
      const result = await create({
        productionId: DEMO,
        changeRequestId: "CR-999",
        baseProductionVersion: 1,
        operations: golden1Remedy,
        summary: "orphan",
        proposedBy: "agent",
      });
      expect(!result.ok && result.error.code).toBe("ENTITY_NOT_FOUND");
    });

    it("refuses an operation outside the allow-list", async () => {
      const result = await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: [{ type: "DELETE_SCENE", sceneId: scenes.s07 } as unknown as ProposedOperation],
        summary: "nope",
        proposedBy: "agent",
      });
      expect(!result.ok && result.error.code).toBe("INVALID_INPUT");
    });
  });

  describe("decideProposal: approve", () => {
    it("records an approval bound to the digest and base version, and marks the proposal approved", async () => {
      await proposeGolden1();
      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
        correlationId: "corr-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stored = await store.proposals.findById(DEMO, "P-1");
      expect(result.value.approval).toEqual({
        id: "A-1",
        productionId: DEMO,
        proposalId: "P-1",
        proposalDigest: stored?.digest,
        productionVersion: 1,
        approvedBy: "jinho@example.test",
        decision: "APPROVE",
        createdAt: NOW,
      });
      expect(result.value.alreadyDecided).toBe(false);
      expect(stored?.status).toBe("APPROVED");
      expect(await store.approvals.findByProposalId(DEMO, "P-1")).toEqual(result.value.approval);
    });

    it("produces a record that satisfies the domain's pre-write gate", async () => {
      await proposeGolden1();
      const decision = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      if (!decision.ok) throw new Error("expected approval");

      const proposal = decision.value.proposal;
      expect(
        checkWriteAllowed({
          proposal,
          approval: decision.value.approval,
          currentProductionVersion: 1,
          recomputedDigest: computeProposalDigest(proposal),
        }),
      ).toEqual({ ok: true });
    });

    it("writes the 'user approved' audit line", async () => {
      await proposeGolden1();
      await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });

      const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
      expect(event).toMatchObject({
        actorType: "USER",
        actorId: "jinho@example.test",
        action: "PROPOSAL_APPROVED",
        entityType: "PROPOSAL",
        entityId: "P-1",
      });
      expect(event?.metadata).toMatchObject({ approvalId: "A-1", productionVersion: 1 });
    });

    it("refuses to approve once the production has moved on, and writes nothing", async () => {
      await proposeGolden1();
      await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });

      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "PRODUCTION_VERSION_MISMATCH",
        expected: "1",
        actual: "2",
      });
      expect(await store.approvals.findByProposalId(DEMO, "P-1")).toBeNull();
      expect((await store.proposals.findById(DEMO, "P-1"))?.status).toBe("AWAITING_APPROVAL");
    });

    it("refuses to approve an invalid draft", async () => {
      await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: [{ ...moveBoth, sceneIds: [scenes.s07] }],
        summary: "Move only Scene 07.",
        proposedBy: "agent",
      });

      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      expect(!result.ok && result.error.code).toBe("PROPOSAL_INVALID");
      expect(await store.approvals.findByProposalId(DEMO, "P-1")).toBeNull();
    });

    it("refuses to approve a proposal whose operations were edited after sealing", async () => {
      const created = await proposeGolden1();
      if (!created.ok) throw new Error("expected proposal");
      await store.proposals.save({ ...created.value, operations: [moveBoth] });

      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      expect(!result.ok && result.error.code).toBe("PROPOSAL_INVALID");
      expect(!result.ok && result.error.nextStep).toContain("Discard");
    });

    it("refuses to approve when the world changed without a version bump and the plan no longer holds", async () => {
      await proposeGolden1();
      const current = (await store.productions.loadState(DEMO))!;
      await store.productions.save(
        withCastUnavailable(current, cast.sarah, onDay(DEMO_MOVIE_DATES.monday)),
      );

      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      expect(!result.ok && result.error.code).toBe("PROPOSAL_INVALID");
    });
  });

  describe("decideProposal: reject and finality", () => {
    it("records a rejection and marks the proposal rejected", async () => {
      await proposeGolden1();
      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "REJECT",
        decidedBy: "jinho@example.test",
      });

      expect(result.ok && result.value.approval.decision).toBe("REJECT");
      expect((await store.proposals.findById(DEMO, "P-1"))?.status).toBe("REJECTED");
      expect((await store.auditEvents.list(DEMO, { limit: 1 }))[0]?.action).toBe(
        "PROPOSAL_REJECTED",
      );
    });

    it("lets a coordinator reject a stale proposal; saying no is always allowed", async () => {
      await proposeGolden1();
      await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });
      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "REJECT",
        decidedBy: "jinho@example.test",
      });
      expect(result.ok).toBe(true);
    });

    it("returns the existing record when the same decision is repeated, writing nothing new", async () => {
      await proposeGolden1();
      const first = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      const auditCount = (await store.auditEvents.list(DEMO)).length;
      const second = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "someone-else@example.test",
      });

      expect(second.ok).toBe(true);
      if (!second.ok || !first.ok) return;
      expect(second.value.alreadyDecided).toBe(true);
      expect(second.value.approval).toEqual(first.value.approval);
      expect((await store.auditEvents.list(DEMO)).length).toBe(auditCount);
    });

    it("refuses to contradict a decision: a decision is final", async () => {
      await proposeGolden1();
      await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      const result = await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "REJECT",
        decidedBy: "jinho@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "CONSTRAINT_VIOLATION",
        expected: "APPROVE",
        actual: "REJECT",
      });
      expect((await store.proposals.findById(DEMO, "P-1"))?.status).toBe("APPROVED");
    });

    it("refuses an unknown proposal and one from another production", async () => {
      await proposeGolden1();
      const missing = await decide({
        productionId: DEMO,
        proposalId: "P-9",
        decision: "APPROVE",
        decidedBy: "x",
      });
      const foreign = await decide({
        productionId: "PROD-OTHER",
        proposalId: "P-1",
        decision: "APPROVE",
        decidedBy: "x",
      });
      expect(!missing.ok && missing.error.code).toBe("ENTITY_NOT_FOUND");
      expect(!foreign.ok && foreign.error.code).toBe("ENTITY_NOT_FOUND");
    });
  });
});
