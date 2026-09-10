import { beforeEach, describe, expect, it } from "vitest";

import type { Proposal, ProposedOperation } from "@pca/contracts";
import { computeProposalDigest } from "@pca/domain";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { onDay, withCastUnavailable } from "@pca/test-support";

import {
  createSimulateProposal,
  createValidateProposal,
  type SimulateProposal,
  type ValidateProposal,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;

const moveWarehouseScenes: ProposedOperation[] = [
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.monday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
];

const sealed = (overrides: Partial<Proposal> = {}): Proposal => {
  const draft: Proposal = {
    id: "P-104",
    productionId: DEMO,
    changeRequestId: "CR-1",
    baseProductionVersion: 1,
    operations: moveWarehouseScenes,
    impacts: [],
    conflicts: [],
    warnings: [],
    validationStatus: "VALID",
    status: "AWAITING_APPROVAL",
    digest: "0".repeat(64),
    summary: "Move Scene 07 and Scene 12 to Monday.",
    createdAt: "2026-09-10T11:04:00.000Z",
    ...overrides,
  };
  return { ...draft, digest: computeProposalDigest(draft) };
};

describe("simulateProposal use case", () => {
  let store: MemoryStore;
  let simulate: SimulateProposal;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.productions.save(
      withCastUnavailable(createDemoMovie(), cast.sarah, onDay(DEMO_MOVIE_DATES.friday)),
    );
    simulate = createSimulateProposal({ repositories: store });
  });

  it("returns a valid would-be world for the GOLDEN-1 remedy without touching the store", async () => {
    const result = await simulate({
      productionId: DEMO,
      baseProductionVersion: 1,
      operations: moveWarehouseScenes,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.resolvedConflicts.map((conflict) => conflict.entityId)).toEqual([
      scenes.s07,
      scenes.s12,
    ]);
    expect(result.value.postStateSummary.staleCallSheetIds).toEqual([
      callSheets.friday,
      callSheets.monday,
    ]);

    const untouched = await store.productions.loadState(DEMO);
    expect(untouched?.production.version).toBe(1);
    expect(untouched?.shootDays.find((day) => day.id === shootDays.friday)?.sceneIds).toEqual([
      scenes.s07,
      scenes.s12,
    ]);
    expect(untouched?.callSheets.every((sheet) => sheet.status === "PUBLISHED")).toBe(true);
  });

  it("refuses to simulate against a version that is no longer current", async () => {
    await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });
    const result = await simulate({
      productionId: DEMO,
      baseProductionVersion: 1,
      operations: moveWarehouseScenes,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "PRODUCTION_VERSION_MISMATCH",
      expected: "1",
      actual: "2",
    });
    expect(result.error.nextStep).toContain("Reload");
  });

  it("refuses an operation outside the allow-list", async () => {
    const result = await simulate({
      productionId: DEMO,
      baseProductionVersion: 1,
      operations: [{ type: "DELETE_SCENE", sceneId: scenes.s07 } as unknown as ProposedOperation],
    });
    expect(!result.ok && result.error.code).toBe("INVALID_INPUT");
  });

  it("refuses an unknown production", async () => {
    const result = await simulate({
      productionId: "PROD-GHOST",
      baseProductionVersion: 1,
      operations: moveWarehouseScenes,
    });
    expect(!result.ok && result.error.code).toBe("ENTITY_NOT_FOUND");
  });
});

describe("validateProposal use case", () => {
  let store: MemoryStore;
  let validate: ValidateProposal;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.productions.save(
      withCastUnavailable(createDemoMovie(), cast.sarah, onDay(DEMO_MOVIE_DATES.friday)),
    );
    validate = createValidateProposal({ repositories: store });
  });

  it("confirms a fresh, intact proposal", async () => {
    await store.proposals.save(sealed());
    const result = await validate({ productionId: DEMO, proposalId: "P-104" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      valid: true,
      productionVersion: 1,
      baseProductionVersion: 1,
      conflicts: [],
    });
    expect(result.value.warnings).toContain("John is required on 2026-09-21 for Scene 07.");
  });

  it("marks a proposal stale once the production moves on, and records that on the proposal", async () => {
    await store.proposals.save(sealed());
    await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });

    const result = await validate({ productionId: DEMO, proposalId: "P-104" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.productionVersion).toBe(2);
    expect(result.value.conflicts[0]).toMatchObject({
      code: "STALE_PRODUCTION_VERSION",
      entityType: "PRODUCTION",
    });

    const stored = await store.proposals.findById(DEMO, "P-104");
    expect(stored?.validationStatus).toBe("INVALID");
    expect(stored?.conflicts[0]?.code).toBe("STALE_PRODUCTION_VERSION");
  });

  it("marks a proposal invalid when the world changed underneath it in a way that breaks it", async () => {
    await store.proposals.save(sealed());
    // Sarah also drops Monday: the move no longer fixes anything.
    const blocked = withCastUnavailable(
      await store.productions.loadState(DEMO).then((state) => state!),
      cast.sarah,
      onDay(DEMO_MOVIE_DATES.monday),
    );
    await store.productions.save(blocked);

    const result = await validate({ productionId: DEMO, proposalId: "P-104" });
    expect(result.ok && result.value.valid).toBe(false);
    expect(result.ok && result.value.conflicts.map((conflict) => conflict.code)).toEqual([
      "CAST_UNAVAILABLE_ON_SHOOT_DAY",
      "CAST_UNAVAILABLE_ON_SHOOT_DAY",
    ]);
  });

  it("refuses a proposal whose operations were edited after it was sealed", async () => {
    const tampered: Proposal = {
      ...sealed(),
      operations: [moveWarehouseScenes[0]!],
    };
    await store.proposals.save(tampered);

    const result = await validate({ productionId: DEMO, proposalId: "P-104" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROPOSAL_INVALID");
    expect(result.error.nextStep).toContain("Discard");
  });

  it("refuses an unknown proposal and one from another production", async () => {
    await store.proposals.save(sealed());
    const missing = await validate({ productionId: DEMO, proposalId: "P-999" });
    const foreign = await validate({ productionId: "PROD-OTHER", proposalId: "P-104" });
    expect(!missing.ok && missing.error.code).toBe("ENTITY_NOT_FOUND");
    expect(!foreign.ok && foreign.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it("does not rewrite a proposal whose verdict has not changed", async () => {
    const original = sealed({ warnings: [], conflicts: [] });
    await store.proposals.save(original);
    await validate({ productionId: DEMO, proposalId: "P-104" });
    const first = await store.proposals.findById(DEMO, "P-104");
    await validate({ productionId: DEMO, proposalId: "P-104" });
    const second = await store.proposals.findById(DEMO, "P-104");
    expect(second).toEqual(first);
  });
});
