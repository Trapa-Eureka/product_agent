import { beforeEach, describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds, approver } from "@pca/test-support";

import type { RepositorySet } from "../src";
import {
  createApplyApprovedProposal,
  createCreateProposal,
  createDecideProposal,
  createSubmitChangeRequest,
  type ApplyApprovedProposal,
  type CreateProposal,
  type DecideProposal,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T11:05:00.000Z";

const golden1: ProposedOperation[] = [
  { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.monday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
];

const golden3: ProposedOperation[] = [
  { type: "ADD_SCENE_REQUIREMENT", sceneId: scenes.s18, requirementType: "PROP", name: "red car" },
  {
    type: "CREATE_PREPARATION_TASK",
    title: "Source a red car for Scene 18",
    relatedEntityType: "SCENE",
    relatedEntityId: scenes.s18,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
];

describe("applyApprovedProposal", () => {
  let store: MemoryStore;
  let create: CreateProposal;
  let decide: DecideProposal;
  let apply: ApplyApprovedProposal;

  /** Runs intake, proposal, and approval; returns the approved proposal ID. */
  const approved = async (operations: ProposedOperation[], summary = "remedy"): Promise<string> => {
    const created = await create({
      productionId: DEMO,
      changeRequestId: "CR-1",
      baseProductionVersion: 1,
      operations,
      summary,
      proposedBy: "agent",
    });
    if (!created.ok) throw new Error(created.error.message);
    const decided = await decide({
      productionId: DEMO,
      proposalId: created.value.id,
      decision: "APPROVE",
      decidedBy: approver("jinho@example.test"),
    });
    if (!decided.ok) throw new Error(decided.error.message);
    return created.value.id;
  };

  const applyIt = (
    proposalId: string,
    overrides: Partial<Parameters<ApplyApprovedProposal>[0]> = {},
  ) =>
    apply({
      productionId: DEMO,
      proposalId,
      approvalId: "A-1",
      expectedProductionVersion: 1,
      idempotencyKey: `apply:${proposalId}:first`,
      appliedBy: "system",
      correlationId: "corr-1",
      ...overrides,
    });

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    const ids = sequentialIds();
    const clock = fixedClock(NOW);
    await createSubmitChangeRequest({ repositories: store, clock, ids })({
      productionId: DEMO,
      rawText: "Sarah cannot shoot Friday.",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      createdBy: "coordinator@example.test",
    });
    create = createCreateProposal({ repositories: store, clock, ids });
    decide = createDecideProposal({ repositories: store, clock, ids });
    apply = createApplyApprovedProposal({ repositories: store, clock, ids });
  });

  describe("INV-7 post-write versioning (TASK-937)", () => {
    it("reports a store that did not advance the version by exactly one as an internal error", async () => {
      const proposalId = await approved(golden1);
      // A store whose commit lands but answers with the wrong version: the
      // guard, not the caller, is what notices.
      const skipping: RepositorySet = {
        ...store,
        applyProposalTransaction: async (commit) => {
          const outcome = await store.applyProposalTransaction(commit);
          return outcome.status === "COMMITTED"
            ? { ...outcome, productionVersion: outcome.productionVersion + 1 }
            : outcome;
        },
      };
      const applyWithSkip = createApplyApprovedProposal({
        repositories: skipping,
        clock: fixedClock(NOW),
        ids: sequentialIds(),
      });

      const result = await applyWithSkip({
        productionId: DEMO,
        proposalId,
        approvalId: "A-1",
        expectedProductionVersion: 1,
        idempotencyKey: `apply:${proposalId}:first`,
        appliedBy: "system",
        correlationId: "corr-7",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "INTERNAL_ERROR",
        expected: "2",
        actual: "3",
        correlationId: "corr-7",
      });
      expect(result.error.message).toMatch(/exactly once/u);
    });
  });

  describe("GOLDEN-1 end to end", () => {
    it("applies the approved remedy, bumps the version, and the production remembers the fact", async () => {
      const proposalId = await approved(golden1);
      const result = await applyIt(proposalId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        applied: true,
        replayed: false,
        productionVersion: 2,
        affectedEntityIds: [
          cast.sarah,
          callSheets.friday,
          callSheets.monday,
          shootDays.friday,
          shootDays.monday,
        ],
        proposalStatus: "APPLIED",
      });

      const after = await store.productions.loadState(DEMO);
      expect(after?.production.version).toBe(2);
      expect(after?.production.updatedAt).toBe(NOW);
      expect(after?.shootDays.map((day) => day.sceneIds)).toEqual([
        [],
        [scenes.s22, scenes.s07, scenes.s12],
        [scenes.s18],
      ]);
      expect(after?.castMembers.find((member) => member.id === cast.sarah)?.unavailable).toEqual([
        onDay(friday),
      ]);
      expect(after?.callSheets.map((sheet) => sheet.status)).toEqual([
        "DRAFT",
        "DRAFT",
        "PUBLISHED",
      ]);
      expect((await store.proposals.findById(DEMO, proposalId))?.status).toBe("APPLIED");
    });

    it("leaves no selected scene on a day Sarah is unavailable", async () => {
      const proposalId = await approved(golden1);
      await applyIt(proposalId);
      const after = await store.productions.loadState(DEMO);
      const fridayDay = after?.shootDays.find((day) => day.date === friday);
      const moved = new Set<string>([scenes.s07, scenes.s12]);
      expect(fridayDay?.sceneIds.filter((id) => moved.has(id))).toEqual([]);
    });

    it("writes the 'system applied' audit line and an idempotency record", async () => {
      const proposalId = await approved(golden1);
      await applyIt(proposalId);

      const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
      expect(event).toMatchObject({
        actorType: "SYSTEM",
        actorId: "system",
        action: "PROPOSAL_APPLIED",
        entityType: "PROPOSAL",
        entityId: proposalId,
        correlationId: "corr-1",
      });
      expect(event?.metadata).toMatchObject({
        productionVersionBefore: 1,
        productionVersionAfter: 2,
        operationCount: 4,
        skippedOperationCount: 0,
      });
      expect(await store.idempotency.find(DEMO, `apply:${proposalId}:first`)).toMatchObject({
        proposalId,
        productionVersionAfter: 2,
      });
    });
  });

  describe("GOLDEN-3 end to end", () => {
    it("creates the requirement and task with real IDs and wires them to the scene", async () => {
      const proposalId = await approved(golden3, "Add a red car to Scene 18.");
      const result = await applyIt(proposalId);

      expect(result.ok && result.value.productionVersion).toBe(2);
      const after = await store.productions.loadState(DEMO);
      const requirement = after?.requirements.find((candidate) => candidate.name === "red car");
      expect(requirement).toMatchObject({
        id: "REQ-1",
        sceneId: scenes.s18,
        type: "PROP",
        status: "NEEDED",
      });
      expect(after?.scenes.find((scene) => scene.id === scenes.s18)?.requirementIds).toEqual([
        "REQ-1",
      ]);
      expect(after?.tasks.at(-1)).toMatchObject({
        id: "T-1",
        title: "Source a red car for Scene 18",
        status: "OPEN",
      });
      expect(result.ok && result.value.affectedEntityIds).toEqual([
        callSheets.tuesday,
        "REQ-1",
        scenes.s18,
        "T-1",
      ]);
    });
  });

  describe("idempotency (INV-8)", () => {
    it("answers a replayed key from its record without touching the production", async () => {
      const proposalId = await approved(golden1);
      const first = await applyIt(proposalId);
      const auditCount = (await store.auditEvents.list(DEMO)).length;
      const second = await applyIt(proposalId);

      expect(second.ok).toBe(true);
      if (!second.ok || !first.ok) return;
      expect(second.value).toEqual({
        ...first.value,
        applied: false,
        replayed: true,
        proposalStatus: "APPLIED",
      });
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(2);
      expect((await store.auditEvents.list(DEMO)).length).toBe(auditCount);
    });

    it("refuses a key reused for different work", async () => {
      const proposalId = await approved(golden1);
      await applyIt(proposalId);
      const other = await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 2,
        operations: golden3,
        summary: "other",
        proposedBy: "agent",
      });
      if (!other.ok) throw new Error("expected proposal");

      const result = await applyIt(other.value.id, {
        idempotencyKey: `apply:${proposalId}:first`,
        expectedProductionVersion: 2,
      });
      expect(!result.ok && result.error.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("refuses to apply an already-applied proposal under a new key", async () => {
      const proposalId = await approved(golden1);
      await applyIt(proposalId);
      const result = await applyIt(proposalId, {
        idempotencyKey: "apply:again",
        expectedProductionVersion: 2,
      });
      expect(!result.ok && result.error.code).toBe("PROPOSAL_INVALID");
      expect(!result.ok && result.error.nextStep).toContain("already applied");
    });
  });

  describe("the approval boundary (INV-5, INV-6)", () => {
    const untouched = async (): Promise<void> => {
      const state = await store.productions.loadState(DEMO);
      expect(state?.production.version).toBe(1);
      expect(state?.shootDays[0]?.sceneIds).toEqual([scenes.s07, scenes.s12]);
      expect(await store.idempotency.find(DEMO, "apply:P-1:first")).toBeNull();
    };

    it("refuses without an approval, and nothing changes", async () => {
      await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: golden1,
        summary: "s",
        proposedBy: "agent",
      });
      const result = await applyIt("P-1", { approvalId: "A-404" });
      expect(!result.ok && result.error.code).toBe("APPROVAL_REQUIRED");
      await untouched();
    });

    it("refuses an approval that belongs to a different proposal", async () => {
      await approved(golden1);
      await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: golden3,
        summary: "s",
        proposedBy: "agent",
      });
      const result = await applyIt("P-2", { approvalId: "A-1" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "APPROVAL_MISMATCH",
        expected: "P-2",
        actual: "P-1",
      });
      await untouched();
    });

    it("refuses a rejected proposal", async () => {
      await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: golden1,
        summary: "s",
        proposedBy: "agent",
      });
      await decide({
        productionId: DEMO,
        proposalId: "P-1",
        decision: "REJECT",
        decidedBy: approver("jinho@example.test"),
      });
      const result = await applyIt("P-1");
      expect(!result.ok && result.error.code).toBe("APPROVAL_REQUIRED");
      await untouched();
    });

    it("refuses once the production has moved on since approval", async () => {
      const proposalId = await approved(golden1);
      await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });
      const result = await applyIt(proposalId, { expectedProductionVersion: 2 });
      expect(!result.ok && result.error.code).toBe("PRODUCTION_VERSION_MISMATCH");
      expect((await store.productions.loadState(DEMO))?.shootDays[0]?.sceneIds).toEqual([
        scenes.s07,
        scenes.s12,
      ]);
    });

    it("refuses when the caller's expected version is wrong, before touching anything", async () => {
      const proposalId = await approved(golden1);
      const result = await applyIt(proposalId, { expectedProductionVersion: 7 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "PRODUCTION_VERSION_MISMATCH",
        expected: "7",
        actual: "1",
      });
      await untouched();
    });

    it("refuses a proposal edited after approval", async () => {
      const proposalId = await approved(golden1);
      const stored = (await store.proposals.findById(DEMO, proposalId))!;
      await store.proposals.save({ ...stored, operations: [golden1[1]!] });
      const result = await applyIt(proposalId);
      expect(!result.ok && result.error.code).toBe("PROPOSAL_INVALID");
      await untouched();
    });

    it("refuses an approval ID from another production", async () => {
      const proposalId = await approved(golden1);
      const result = await apply({
        productionId: "PROD-OTHER",
        proposalId,
        approvalId: "A-1",
        expectedProductionVersion: 1,
        idempotencyKey: "apply:foreign",
      });
      expect(!result.ok && result.error.code).toBe("ENTITY_NOT_FOUND");
      await untouched();
    });

    it("refuses a malformed request", async () => {
      const result = await applyIt("P-1", { idempotencyKey: "x" });
      expect(!result.ok && result.error.code).toBe("INVALID_INPUT");
    });
  });
});
