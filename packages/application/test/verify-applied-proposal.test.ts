import { beforeEach, describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds } from "@pca/test-support";

import {
  createApplyApprovedProposal,
  createCreateProposal,
  createDecideProposal,
  createSubmitChangeRequest,
  createVerifyAppliedProposal,
  type VerifyAppliedProposal,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T11:05:30.000Z";

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

describe("verifyAppliedProposal", () => {
  let store: MemoryStore;
  let verify: VerifyAppliedProposal;
  let runThroughApply: (operations: ProposedOperation[]) => Promise<string>;
  let proposeOnly: (operations: ProposedOperation[]) => Promise<string>;

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    const ids = sequentialIds();
    const clock = fixedClock(NOW);
    const deps = { repositories: store, clock, ids };
    await createSubmitChangeRequest(deps)({
      productionId: DEMO,
      rawText: "Sarah cannot shoot Friday.",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      createdBy: "coordinator@example.test",
    });
    const create = createCreateProposal(deps);
    const decide = createDecideProposal(deps);
    const apply = createApplyApprovedProposal(deps);
    verify = createVerifyAppliedProposal(deps);

    proposeOnly = async (operations) => {
      const created = await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations,
        summary: "remedy",
        proposedBy: "agent",
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.value.id;
    };

    runThroughApply = async (operations) => {
      const proposalId = await proposeOnly(operations);
      const decided = await decide({
        productionId: DEMO,
        proposalId,
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      if (!decided.ok) throw new Error(decided.error.message);
      const applied = await apply({
        productionId: DEMO,
        proposalId,
        approvalId: decided.value.approval.id,
        expectedProductionVersion: 1,
        idempotencyKey: `apply:${proposalId}:first`,
      });
      if (!applied.ok) throw new Error(applied.error.message);
      return proposalId;
    };
  });

  it("passes every check after GOLDEN-1 is applied, and records that it did", async () => {
    const proposalId = await runThroughApply(golden1);
    const result = await verify({ productionId: DEMO, proposalId, correlationId: "corr-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect(result.value.checks.map((entry) => [entry.name, entry.passed])).toEqual([
      ["1. Sarah recorded unavailable 2026-09-18 to 2026-09-18", true],
      ["2. Scene 07, Scene 12 moved to 2026-09-21", true],
      ["3. Call sheet CS-2026-09-18 is a draft", true],
      ["4. Call sheet CS-2026-09-21 is a draft", true],
      ["No scene requiring Sarah remains scheduled while Sarah is unavailable", true],
      ["Production satisfies every invariant", true],
      ["Production version advanced past the proposal's base", true],
      ["Proposal is marked APPLIED", true],
      ["Apply was audited", true],
    ]);

    const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
    expect(event).toMatchObject({
      actorType: "SYSTEM",
      action: "PROPOSAL_VERIFIED",
      entityType: "PROPOSAL",
      entityId: proposalId,
      correlationId: "corr-1",
    });
    expect(event?.metadata).toMatchObject({
      checkCount: 9,
      failedChecks: [],
      productionVersion: 2,
    });
  });

  it("notices the write that landed without its bookkeeping, and records the failure", async () => {
    const proposalId = await runThroughApply(golden1);
    const stored = (await store.proposals.findById(DEMO, proposalId))!;
    await store.proposals.save({ ...stored, status: "APPROVED" });

    const result = await verify({ productionId: DEMO, proposalId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(false);
    const failed = result.value.checks.filter((entry) => !entry.passed);
    expect(failed.map((entry) => entry.name)).toEqual(["Proposal is marked APPLIED"]);
    expect(failed[0]?.detail).toContain("the write landed but its bookkeeping did not");

    const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
    expect(event?.action).toBe("PROPOSAL_VERIFICATION_FAILED");
    expect(event?.metadata).toMatchObject({ failedChecks: ["Proposal is marked APPLIED"] });
  });

  it("notices effects that were undone after the apply", async () => {
    const proposalId = await runThroughApply(golden1);
    const state = (await store.productions.loadState(DEMO))!;
    await store.productions.commit({
      productionId: DEMO,
      expectedVersion: 2,
      shootDays: [
        { ...state.shootDays[0]!, sceneIds: [scenes.s07, scenes.s12] },
        { ...state.shootDays[1]!, sceneIds: [scenes.s22] },
      ],
    });

    const result = await verify({ productionId: DEMO, proposalId });
    expect(result.ok && result.value.success).toBe(false);
    expect(
      result.ok && result.value.checks.filter((entry) => !entry.passed).map((entry) => entry.name),
    ).toEqual([
      "2. Scene 07, Scene 12 moved to 2026-09-21",
      "No scene requiring Sarah remains scheduled while Sarah is unavailable",
      "Production satisfies every invariant",
    ]);
  });

  it("reports an un-applied proposal honestly rather than as an error", async () => {
    const proposalId = await proposeOnly(golden1);
    const result = await verify({ productionId: DEMO, proposalId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(false);
    // Only the invariants hold: the untouched world is valid, but Sarah's scenes
    // are still inside the window the proposal would have recorded.
    expect(result.value.checks.filter((entry) => entry.passed).map((entry) => entry.name)).toEqual([
      "Production satisfies every invariant",
    ]);
    expect(
      result.value.checks.find((entry) => entry.name.startsWith("No scene requiring Sarah"))
        ?.detail,
    ).toBe("Scene 07, Scene 12 still scheduled inside the window.");
    expect(result.value.checks.find((entry) => entry.name === "Apply was audited")?.passed).toBe(
      false,
    );
  });

  it("refuses an unknown proposal and one from another production", async () => {
    const proposalId = await runThroughApply(golden1);
    const missing = await verify({ productionId: DEMO, proposalId: "P-9" });
    const foreign = await verify({ productionId: "PROD-OTHER", proposalId });
    expect(!missing.ok && missing.error.code).toBe("ENTITY_NOT_FOUND");
    expect(!foreign.ok && foreign.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it("never changes the production", async () => {
    const proposalId = await runThroughApply(golden1);
    const before = await store.productions.loadState(DEMO);
    await verify({ productionId: DEMO, proposalId });
    expect(await store.productions.loadState(DEMO)).toEqual(before);
  });
});
