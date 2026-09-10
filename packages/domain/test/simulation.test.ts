import { describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { onDay, withCastUnavailable } from "@pca/test-support";

import { indexProduction } from "../src/production-state";
import { applyOperations, simulateProposal, simulationIds } from "../src/simulation";

const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday } = DEMO_MOVIE_DATES;

/** The Demo Movie after Sarah's Friday conflict has been recorded (GOLDEN-1). */
const afterSarahConflict = () =>
  indexProduction(withCastUnavailable(createDemoMovie(), cast.sarah, onDay(friday)));

const moveBoth: ProposedOperation = {
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

const golden3Remedy: ProposedOperation[] = [
  {
    type: "ADD_SCENE_REQUIREMENT",
    sceneId: scenes.s18,
    requirementType: "PROP",
    name: "red car",
  },
  {
    type: "CREATE_PREPARATION_TASK",
    title: "Source a red car for Scene 18",
    relatedEntityType: "SCENE",
    relatedEntityId: scenes.s18,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
];

describe("GOLDEN-1 remedy: move the Warehouse scenes to Monday", () => {
  const outcome = simulateProposal(afterSarahConflict(), golden1Remedy);

  it("is valid: the would-be world satisfies every invariant", () => {
    expect(outcome.valid).toBe(true);
    expect(outcome.conflicts).toEqual([]);
  });

  it("resolves exactly Sarah's two Friday conflicts", () => {
    expect(outcome.resolvedConflicts.map((conflict) => [conflict.code, conflict.entityId])).toEqual(
      [
        ["CAST_UNAVAILABLE_ON_SHOOT_DAY", scenes.s07],
        ["CAST_UNAVAILABLE_ON_SHOOT_DAY", scenes.s12],
      ],
    );
  });

  it("leaves Friday empty and puts both scenes after Scene 22 on Monday", () => {
    expect(outcome.summary.shootDays).toEqual([
      { id: shootDays.friday, date: friday, sceneIds: [] },
      { id: shootDays.monday, date: monday, sceneIds: [scenes.s22, scenes.s07, scenes.s12] },
      { id: shootDays.tuesday, date: DEMO_MOVIE_DATES.tuesday, sceneIds: [scenes.s18] },
    ]);
  });

  it("lists the two call sheets that go stale", () => {
    expect(outcome.summary.staleCallSheetIds).toEqual([callSheets.friday, callSheets.monday]);
    expect(outcome.postState.callSheets.map((sheet) => [sheet.id, sheet.status])).toEqual([
      [callSheets.friday, "DRAFT"],
      [callSheets.monday, "DRAFT"],
      [callSheets.tuesday, "PUBLISHED"],
    ]);
  });

  it("carries the effects the proposal view shows as warnings", () => {
    expect(outcome.warnings).toEqual([
      "John is required on 2026-09-21 for Scene 07.",
      "Sarah is required on 2026-09-21 for Scene 07.",
      "Warehouse is needed on 2026-09-21 for Scene 07.",
      "Shoot day 2026-09-18 loses scenes 07, 12.",
      "Shoot day 2026-09-21 gains scenes 07, 12.",
      "Call sheet CS-2026-09-18 is derived from shoot day 2026-09-18 and must be regenerated.",
      "Call sheet CS-2026-09-21 is derived from shoot day 2026-09-21 and must be regenerated.",
    ]);
  });

  it("applies every operation and skips none", () => {
    expect(outcome.applied).toEqual(golden1Remedy);
    expect(outcome.skipped).toEqual([]);
  });

  it("does not touch the snapshot it was given", () => {
    const index = afterSarahConflict();
    const before = JSON.stringify(index.state);
    simulateProposal(index, golden1Remedy);
    expect(JSON.stringify(index.state)).toBe(before);
  });
});

describe("a partial remedy is not a valid one", () => {
  it("moving only Scene 07 leaves Scene 12 conflicting, so the proposal is invalid", () => {
    const outcome = simulateProposal(afterSarahConflict(), [
      { ...moveBoth, sceneIds: [scenes.s07] },
    ]);

    expect(outcome.valid).toBe(false);
    expect(outcome.resolvedConflicts.map((conflict) => conflict.entityId)).toEqual([scenes.s07]);
    expect(outcome.conflicts).toEqual([
      {
        code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scenes.s12,
        date: friday,
        detail: "Scene 12 is scheduled on 2026-09-18 but Sarah is unavailable that day.",
      },
    ]);
  });

  it("moving onto a day Sarah also cannot make trades Friday conflicts for Monday ones and stays invalid", () => {
    const index = indexProduction(
      withCastUnavailable(afterSarahConflict().state, cast.sarah, onDay(monday)),
    );
    const outcome = simulateProposal(index, [moveBoth]);

    expect(outcome.valid).toBe(false);
    expect(outcome.resolvedConflicts.map((conflict) => [conflict.entityId, conflict.date])).toEqual(
      [
        [scenes.s07, friday],
        [scenes.s12, friday],
      ],
    );
    expect(outcome.conflicts.map((conflict) => [conflict.entityId, conflict.date])).toEqual([
      [scenes.s07, monday],
      [scenes.s12, monday],
    ]);
  });
});

describe("GOLDEN-3 remedy: add the red car and a preparation task", () => {
  const outcome = simulateProposal(indexProduction(createDemoMovie()), golden3Remedy);

  it("is valid and raises no conflicts", () => {
    expect(outcome.valid).toBe(true);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.resolvedConflicts).toEqual([]);
  });

  it("reports what would be created, by name rather than by placeholder ID", () => {
    expect(outcome.summary.addedRequirementNames).toEqual(["red car"]);
    expect(outcome.summary.addedTaskTitles).toEqual(["Source a red car for Scene 18"]);
    expect(outcome.summary.staleCallSheetIds).toEqual([callSheets.tuesday]);
  });

  it("wires the new requirement onto the scene in the would-be world", () => {
    const scene = outcome.postState.scenes.find((candidate) => candidate.id === scenes.s18);
    const requirement = outcome.postState.requirements.find(
      (candidate) => candidate.name === "red car",
    );
    expect(requirement).toMatchObject({
      id: "SIM-REQ-1",
      sceneId: scenes.s18,
      type: "PROP",
      status: "NEEDED",
    });
    expect(scene?.requirementIds).toEqual(["SIM-REQ-1"]);
    expect(outcome.postState.tasks.at(-1)).toMatchObject({ id: "SIM-T-1", status: "OPEN" });
  });

  it("replayed on its own result, changes nothing and says why", () => {
    const replay = simulateProposal(indexProduction(outcome.postState), golden3Remedy);

    expect(replay.valid).toBe(true);
    expect(replay.applied).toEqual([]);
    expect(replay.skipped.map((entry) => entry.reason)).toEqual([
      'Scene 18 already has the PROP "red car"; nothing to add.',
      'An open task "Source a red car for Scene 18" already exists; nothing to create.',
      "Call sheet CS-2026-09-22 is already a draft; nothing to mark.",
    ]);
    expect(replay.summary.addedRequirementNames).toEqual([]);
    expect(replay.postState.requirements).toHaveLength(outcome.postState.requirements.length);
  });
});

describe("operations that cannot apply", () => {
  const demo = () => indexProduction(createDemoMovie());

  it("refuses to move a scene from a day it is not on, and applies nothing for that operation", () => {
    const outcome = simulateProposal(demo(), [
      {
        ...moveBoth,
        sceneIds: [scenes.s22],
        fromShootDayId: shootDays.friday,
        toShootDayId: shootDays.tuesday,
      },
    ]);

    expect(outcome.valid).toBe(false);
    expect(outcome.conflicts).toEqual([
      {
        code: "SCENE_MISSING_FROM_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scenes.s22,
        date: friday,
        detail: "Scene 22 is not scheduled on 2026-09-18; it is on 2026-09-21.",
      },
    ]);
    expect(outcome.summary.shootDays.map((day) => day.sceneIds)).toEqual([
      [scenes.s07, scenes.s12],
      [scenes.s22],
      [scenes.s18],
    ]);
  });

  it("treats a move whose scene already sits on the target as already done, whatever source it names", () => {
    const outcome = simulateProposal(demo(), [
      { ...moveBoth, sceneIds: [scenes.s22], fromShootDayId: shootDays.friday },
    ]);

    expect(outcome.valid).toBe(true);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped[0]?.reason).toBe(
      "Scenes S22 are already on 2026-09-21; nothing to move.",
    );
  });

  it("refuses an unknown call sheet or shoot day rather than throwing", () => {
    const outcome = simulateProposal(demo(), [
      { type: "MARK_CALL_SHEET_STALE", callSheetId: "CS-GHOST" },
      { ...moveBoth, toShootDayId: "SD-GHOST" },
    ]);

    expect(outcome.conflicts.map((conflict) => [conflict.code, conflict.entityId])).toEqual([
      ["UNKNOWN_ENTITY_REFERENCE", "CS-GHOST"],
      ["UNKNOWN_ENTITY_REFERENCE", "SD-GHOST"],
    ]);
  });

  it("treats each operation atomically: one bad scene blocks that move, not the others", () => {
    const outcome = simulateProposal(demo(), [
      { ...moveBoth, sceneIds: [scenes.s07, "S99"] },
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
    ]);

    expect(outcome.applied).toEqual([
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
    ]);
    expect(outcome.summary.shootDays[0]?.sceneIds).toEqual([scenes.s07, scenes.s12]);
  });

  it("lets a later operation see an earlier one's effect", () => {
    const outcome = applyOperations(
      createDemoMovie(),
      [
        moveBoth,
        { ...moveBoth, fromShootDayId: shootDays.monday, toShootDayId: shootDays.tuesday },
      ],
      simulationIds(),
    );

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.state.shootDays.map((day) => day.sceneIds)).toEqual([
      [],
      [scenes.s22],
      [scenes.s18, scenes.s07, scenes.s12],
    ]);
  });
});
