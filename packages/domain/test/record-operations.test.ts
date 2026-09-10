import { describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { onDay } from "@pca/test-support";

import { isRangeCovered } from "../src/dates";
import { isOperationAlreadyApplied } from "../src/operations";
import { indexProduction } from "../src/production-state";
import { applyOperations, simulateProposal, simulationIds } from "../src/simulation";

const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday } = DEMO_MOVIE_DATES;

const recordSarah: ProposedOperation = {
  type: "RECORD_CAST_UNAVAILABILITY",
  castId: cast.sarah,
  unavailable: onDay(friday),
};

const recordWarehouse: ProposedOperation = {
  type: "RECORD_LOCATION_UNAVAILABILITY",
  locationId: locations.warehouse,
  unavailable: onDay(friday),
};

const moveBoth: ProposedOperation = {
  type: "MOVE_SCENES",
  sceneIds: [scenes.s07, scenes.s12],
  fromShootDayId: shootDays.friday,
  toShootDayId: shootDays.monday,
};

/** The full GOLDEN-1 proposal as the orchestrator will build it: the fact, then the remedy. */
const golden1: ProposedOperation[] = [
  recordSarah,
  moveBoth,
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
];

describe("isRangeCovered", () => {
  it("is covered by a window that contains it, even across merged adjacent windows", () => {
    expect(
      isRangeCovered(
        [
          { start: "2026-09-18", end: "2026-09-18" },
          { start: "2026-09-19", end: "2026-09-21" },
        ],
        { start: "2026-09-18", end: "2026-09-21" },
      ),
    ).toBe(true);
  });

  it("is not covered when any day of the range is free", () => {
    expect(
      isRangeCovered([{ start: "2026-09-18", end: "2026-09-18" }], {
        start: "2026-09-18",
        end: "2026-09-19",
      }),
    ).toBe(false);
  });
});

describe("recording unavailability", () => {
  it("writes the window onto the cast member in the would-be world", () => {
    const outcome = applyOperations(createDemoMovie(), [recordSarah], simulationIds());
    const sarah = outcome.state.castMembers.find((member) => member.id === cast.sarah);

    expect(outcome.applied).toEqual([recordSarah]);
    expect(sarah?.unavailable).toEqual([onDay(friday)]);
  });

  it("merges into existing windows rather than appending duplicates", () => {
    const state = createDemoMovie();
    const outcome = applyOperations(
      state,
      [{ ...recordSarah, unavailable: { start: "2026-09-19", end: "2026-09-20" } }, recordSarah],
      simulationIds(),
    );
    const sarah = outcome.state.castMembers.find((member) => member.id === cast.sarah);
    expect(sarah?.unavailable).toEqual([{ start: "2026-09-18", end: "2026-09-20" }]);
  });

  it("writes the window onto the location", () => {
    const outcome = applyOperations(createDemoMovie(), [recordWarehouse], simulationIds());
    const warehouse = outcome.state.locations.find(
      (location) => location.id === locations.warehouse,
    );
    expect(warehouse?.unavailable).toEqual([onDay(friday)]);
  });

  it("is already applied once the window is covered, and skipped on replay", () => {
    const after = applyOperations(createDemoMovie(), [recordSarah], simulationIds()).state;
    expect(isOperationAlreadyApplied(indexProduction(after), recordSarah)).toBe(true);

    const replay = applyOperations(after, [recordSarah], simulationIds());
    expect(replay.applied).toEqual([]);
    expect(replay.skipped[0]?.reason).toBe(
      "Sarah is already recorded as unavailable 2026-09-18 to 2026-09-18; nothing to record.",
    );
  });

  it("does not touch the original snapshot", () => {
    const state = createDemoMovie();
    applyOperations(state, [recordSarah, recordWarehouse], simulationIds());
    expect(state.castMembers.find((member) => member.id === cast.sarah)?.unavailable).toEqual([]);
    expect(
      state.locations.find((location) => location.id === locations.warehouse)?.unavailable,
    ).toEqual([]);
  });

  it("refuses an unknown cast member or location with a conflict", () => {
    const outcome = applyOperations(
      createDemoMovie(),
      [
        { ...recordSarah, castId: "CAST-GHOST" },
        { ...recordWarehouse, locationId: "LOC-GHOST" },
      ],
      simulationIds(),
    );
    expect(outcome.conflicts.map((conflict) => [conflict.entityType, conflict.entityId])).toEqual([
      ["CAST_MEMBER", "CAST-GHOST"],
      ["LOCATION", "LOC-GHOST"],
    ]);
  });
});

describe("GOLDEN-1 as a single proposal: the fact, then the remedy", () => {
  const outcome = simulateProposal(indexProduction(createDemoMovie()), golden1);

  it("is valid, and Sarah's Friday window survives into the would-be world", () => {
    expect(outcome.valid).toBe(true);
    expect(outcome.conflicts).toEqual([]);
    expect(
      outcome.postState.castMembers.find((member) => member.id === cast.sarah)?.unavailable,
    ).toEqual([onDay(friday)]);
  });

  it("still reports the resolution, measured from the world with the fact recorded", () => {
    expect(outcome.resolvedConflicts.map((conflict) => [conflict.code, conflict.entityId])).toEqual(
      [
        ["CAST_UNAVAILABLE_ON_SHOOT_DAY", scenes.s07],
        ["CAST_UNAVAILABLE_ON_SHOOT_DAY", scenes.s12],
      ],
    );
  });

  it("leads the impact list with the recorded fact", () => {
    expect(outcome.impacts.find((impact) => impact.reasonCode === "AVAILABILITY_RECORDED")).toEqual(
      {
        entityType: "CAST_MEMBER",
        entityId: cast.sarah,
        reasonCode: "AVAILABILITY_RECORDED",
        explanation: "Sarah is recorded as unavailable 2026-09-18 to 2026-09-18.",
        severity: "INFO",
      },
    );
  });

  it("recording the fact without a remedy is invalid: the plan is now conflicted", () => {
    const factOnly = simulateProposal(indexProduction(createDemoMovie()), [recordSarah]);
    expect(factOnly.valid).toBe(false);
    expect(factOnly.conflicts.map((conflict) => conflict.entityId)).toEqual([
      scenes.s07,
      scenes.s12,
    ]);
    expect(factOnly.resolvedConflicts).toEqual([]);
  });

  it("replayed on its own result, changes nothing and skips every operation", () => {
    const replay = simulateProposal(indexProduction(outcome.postState), golden1);
    expect(replay.valid).toBe(true);
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toHaveLength(4);
  });

  it("resolves the location scenario the same way", () => {
    const golden2 = simulateProposal(indexProduction(createDemoMovie()), [
      recordWarehouse,
      moveBoth,
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
    ]);
    expect(golden2.valid).toBe(true);
    expect(golden2.resolvedConflicts.map((conflict) => conflict.code)).toEqual([
      "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
      "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
    ]);
    expect(golden2.summary.shootDays[1]?.date).toBe(monday);
  });
});
