import { describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";

import { canonicalJson, canonicalProposalPayload, computeProposalDigest } from "../src/digest";
import { indexProduction } from "../src/production-state";
import { isOperationAlreadyApplied, staleCallSheetIdsForShootDays } from "../src/operations";
import { findEquivalentRequirement, normalizeRequirementName } from "../src/requirements";
import {
  aCallSheet,
  aLocation,
  aProductionState,
  aRequirement,
  aScene,
  aShootDay,
  aTask,
} from "./builders";

const baseDigestInput = {
  productionId: "PROD-DEMO",
  changeRequestId: "CR-001",
  baseProductionVersion: 12,
  operations: [
    {
      type: "MOVE_SCENES",
      sceneIds: ["S07", "S12"],
      fromShootDayId: "SD-2026-09-18",
      toShootDayId: "SD-2026-09-21",
    },
  ] satisfies ProposedOperation[],
};

describe("canonicalJson", () => {
  it("orders object keys so equal content hashes equally", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("preserves array order, because operation order is part of the plan", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("omits undefined values rather than emitting them", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("computeProposalDigest", () => {
  it("is stable across calls", () => {
    expect(computeProposalDigest(baseDigestInput)).toBe(computeProposalDigest(baseDigestInput));
  });

  it("produces a lowercase hex sha-256", () => {
    expect(computeProposalDigest(baseDigestInput)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when an operation changes", () => {
    const altered = {
      ...baseDigestInput,
      operations: [{ ...baseDigestInput.operations[0], sceneIds: ["S07"] }] as ProposedOperation[],
    };
    expect(computeProposalDigest(altered)).not.toBe(computeProposalDigest(baseDigestInput));
  });

  it("changes when the base production version changes", () => {
    expect(computeProposalDigest({ ...baseDigestInput, baseProductionVersion: 13 })).not.toBe(
      computeProposalDigest(baseDigestInput),
    );
  });

  it("covers only what an approver authorises", () => {
    expect(canonicalProposalPayload(baseDigestInput)).not.toContain("warning");
  });
});

describe("requirement identity", () => {
  it.each([
    ["Red Car", "red car"],
    ["  red   car  ", "red car"],
    ["RED CAR", "red car"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRequirementName(input)).toBe(expected);
  });

  it("finds an existing requirement that differs only by spacing and case", () => {
    const existing = [aRequirement({ name: "Red  Car" })];
    expect(findEquivalentRequirement(existing, { type: "PROP", name: "red car" })?.id).toBe(
      "REQ-1",
    );
  });

  it("does not match the same name under a different requirement type", () => {
    const existing = [aRequirement({ type: "VEHICLE", name: "red car" })];
    expect(findEquivalentRequirement(existing, { type: "PROP", name: "red car" })).toBeNull();
  });
});

describe("INV-8 natural idempotency", () => {
  const indexWith = (overrides: Parameters<typeof aProductionState>[0]) =>
    indexProduction(aProductionState({ locations: [aLocation()], ...overrides }));

  it("treats a move as applied once the scenes sit on the target day", () => {
    const index = indexWith({
      scenes: [aScene({ id: "S07" })],
      shootDays: [
        aShootDay({ sceneIds: [] }),
        aShootDay({ id: "SD-MON", date: "2026-09-21", sceneIds: ["S07"] }),
      ],
    });

    expect(
      isOperationAlreadyApplied(index, {
        type: "MOVE_SCENES",
        sceneIds: ["S07"],
        fromShootDayId: "SD-2026-09-18",
        toShootDayId: "SD-MON",
      }),
    ).toBe(true);
  });

  it("does not treat a move as applied while a scene is still on the source day", () => {
    const index = indexWith({
      scenes: [aScene({ id: "S07" })],
      shootDays: [
        aShootDay({ sceneIds: ["S07"] }),
        aShootDay({ id: "SD-MON", date: "2026-09-21", sceneIds: ["S07"] }),
      ],
    });

    expect(
      isOperationAlreadyApplied(index, {
        type: "MOVE_SCENES",
        sceneIds: ["S07"],
        fromShootDayId: "SD-2026-09-18",
        toShootDayId: "SD-MON",
      }),
    ).toBe(false);
  });

  it("treats adding a requirement the scene already has as applied", () => {
    const index = indexWith({
      scenes: [aScene({ requirementIds: ["REQ-1"] })],
      requirements: [aRequirement({ name: "Red Car" })],
    });

    expect(
      isOperationAlreadyApplied(index, {
        type: "ADD_SCENE_REQUIREMENT",
        sceneId: "S01",
        requirementType: "PROP",
        name: "red car",
      }),
    ).toBe(true);
  });

  it("treats an identical open preparation task as already created", () => {
    const index = indexWith({ scenes: [aScene()], tasks: [aTask()] });

    expect(
      isOperationAlreadyApplied(index, {
        type: "CREATE_PREPARATION_TASK",
        title: "source a red car",
        relatedEntityType: "SCENE",
        relatedEntityId: "S01",
      }),
    ).toBe(true);
  });

  it("does not count a completed task as satisfying a new preparation task", () => {
    const index = indexWith({ scenes: [aScene()], tasks: [aTask({ status: "DONE" })] });

    expect(
      isOperationAlreadyApplied(index, {
        type: "CREATE_PREPARATION_TASK",
        title: "Source a red car",
        relatedEntityType: "SCENE",
        relatedEntityId: "S01",
      }),
    ).toBe(false);
  });

  it("treats an already-draft call sheet as already flagged for regeneration", () => {
    const index = indexWith({ callSheets: [aCallSheet({ status: "DRAFT" })] });

    expect(
      isOperationAlreadyApplied(index, {
        type: "MARK_CALL_SHEET_STALE",
        callSheetId: "CS-2026-09-18",
      }),
    ).toBe(true);
  });
});

describe("staleCallSheetIdsForShootDays (TASK-937)", () => {
  it("names each published sheet on the days once, and never a draft or an unknown day", () => {
    const index = indexProduction(
      aProductionState({
        locations: [aLocation()],
        shootDays: [aShootDay(), aShootDay({ id: "SD-MON", date: "2026-09-21", sceneIds: [] })],
        callSheets: [
          aCallSheet(),
          aCallSheet({ id: "CS-MON", shootDayId: "SD-MON" }),
          aCallSheet({ id: "CS-MON-DRAFT", shootDayId: "SD-MON", status: "DRAFT" }),
        ],
      }),
    );

    expect(
      staleCallSheetIdsForShootDays(index, ["SD-2026-09-18", "SD-MON", "SD-2026-09-18"]),
    ).toEqual(["CS-2026-09-18", "CS-MON"]);
    expect(staleCallSheetIdsForShootDays(index, ["SD-UNKNOWN"])).toEqual([]);
  });
});
