import { describe, expect, it } from "vitest";

import type { Impact, TypedChange } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";

import { analyzeImpact } from "../src/impact";
import { indexProduction } from "../src/production-state";

const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;

const demo = () => indexProduction(createDemoMovie());

/** Reduces an impact to the three fields the golden scenarios pin down. */
const shape = (impact: Impact) => [impact.severity, impact.entityType, impact.entityId] as const;

const sarahOnFriday: TypedChange = {
  type: "CAST_UNAVAILABLE",
  castId: cast.sarah,
  unavailable: { start: friday, end: friday },
};

const warehouseOnFriday: TypedChange = {
  type: "LOCATION_UNAVAILABLE",
  locationId: locations.warehouse,
  unavailable: { start: friday, end: friday },
};

const redCarForScene18: TypedChange = {
  type: "SCENE_REQUIREMENT_CHANGED",
  sceneId: scenes.s18,
  requirement: { type: "PROP", name: "red car" },
};

/**
 * These are the project's most important acceptance signal (TESTING.md §4).
 * They assert exact arrays, not "contains": a coordinator who is shown one
 * extra scene learns to skim the list, and a coordinator shown one fewer
 * ships a broken day.
 */
describe("GOLDEN-1: Sarah unavailable Friday", () => {
  const analysis = analyzeImpact(demo(), sarahOnFriday);

  it("affects exactly S07 and S12, the Friday shoot day, its call sheet, and their attachments", () => {
    expect(analysis.impacts.map(shape)).toEqual([
      ["BLOCKING", "SCENE", scenes.s07],
      ["BLOCKING", "SCENE", scenes.s12],
      ["WARNING", "SHOOT_DAY", shootDays.friday],
      ["WARNING", "CALL_SHEET", callSheets.friday],
      ["INFO", "CAST_MEMBER", cast.john],
      ["INFO", "LOCATION", locations.warehouse],
      ["INFO", "TASK", "T-001"],
      ["INFO", "TASK", "T-002"],
      ["INFO", "TASK", "T-003"],
    ]);
  });

  it("reports one blocking cast conflict per affected scene", () => {
    expect(analysis.conflicts).toEqual([
      {
        code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scenes.s07,
        date: friday,
        detail: "Sarah is unavailable on 2026-09-18 but Scene 07 is scheduled that day.",
      },
      {
        code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scenes.s12,
        date: friday,
        detail: "Sarah is unavailable on 2026-09-18 but Scene 12 is scheduled that day.",
      },
    ]);
  });

  it("lists every affected entity once, sorted", () => {
    expect(analysis.affectedEntityIds).toEqual([
      cast.john,
      callSheets.friday,
      locations.warehouse,
      scenes.s07,
      scenes.s12,
      shootDays.friday,
      "T-001",
      "T-002",
      "T-003",
    ]);
  });

  it("explains each finding from data, in the words the WHY panel shows", () => {
    const why = Object.fromEntries(
      analysis.impacts.map((impact) => [impact.entityId, impact.explanation]),
    );
    expect(why[scenes.s07]).toBe(
      "Scene 07 requires Sarah and is scheduled on 2026-09-18, when Sarah is unavailable.",
    );
    expect(why[shootDays.friday]).toBe(
      "Shoot day 2026-09-18 contains scenes 07, 12, which cannot proceed while Sarah is unavailable.",
    );
    expect(why[callSheets.friday]).toBe(
      "Call sheet CS-2026-09-18 is derived from shoot day 2026-09-18 and must be regenerated.",
    );
    expect(why[cast.john]).toBe(
      "John is required by Scene 07, so any move affects their schedule.",
    );
  });

  it("does not list Sarah herself, who is the cause rather than an effect", () => {
    expect(analysis.affectedEntityIds).not.toContain(cast.sarah);
  });
});

describe("GOLDEN-2: Warehouse unavailable Friday", () => {
  const analysis = analyzeImpact(demo(), warehouseOnFriday);

  it("affects S07 and S12, Friday, its call sheet, both cast members, and the open tasks", () => {
    expect(analysis.impacts.map(shape)).toEqual([
      ["BLOCKING", "SCENE", scenes.s07],
      ["BLOCKING", "SCENE", scenes.s12],
      ["WARNING", "SHOOT_DAY", shootDays.friday],
      ["WARNING", "CALL_SHEET", callSheets.friday],
      ["INFO", "CAST_MEMBER", cast.john],
      ["INFO", "CAST_MEMBER", cast.sarah],
      ["INFO", "TASK", "T-001"],
      ["INFO", "TASK", "T-002"],
      ["INFO", "TASK", "T-003"],
    ]);
  });

  it("carries the cast implications the scenario calls for", () => {
    expect(analysis.affectedEntityIds).toEqual(expect.arrayContaining([cast.sarah, cast.john]));
  });

  it("reports location conflicts, not cast conflicts", () => {
    expect(analysis.conflicts.map((conflict) => conflict.code)).toEqual([
      "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
      "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
    ]);
  });

  it("does not list the Warehouse itself", () => {
    expect(analysis.affectedEntityIds).not.toContain(locations.warehouse);
  });
});

describe("GOLDEN-3: Scene 18 needs a red car", () => {
  const analysis = analyzeImpact(demo(), redCarForScene18);

  it("affects S18, its Tuesday shoot day, and that day's call sheet, and nothing else", () => {
    expect(analysis.impacts.map(shape)).toEqual([
      ["WARNING", "SHOOT_DAY", shootDays.tuesday],
      ["WARNING", "CALL_SHEET", callSheets.tuesday],
      ["INFO", "SCENE", scenes.s18],
    ]);
  });

  it("marks the scene as gaining a requirement rather than as broken", () => {
    const scene = analysis.impacts.find((impact) => impact.entityId === scenes.s18);
    expect(scene?.reasonCode).toBe("SCENE_REQUIREMENT_ADDED");
    expect(scene?.explanation).toBe("Scene 18 gains a new PROP requirement: red car.");
  });

  it("raises no conflicts: adding a prop invalidates nothing", () => {
    expect(analysis.conflicts).toEqual([]);
  });

  it("tells the coordinator when the prop must be ready", () => {
    const day = analysis.impacts.find((impact) => impact.entityId === shootDays.tuesday);
    expect(day?.explanation).toBe(
      `Shoot day ${tuesday} contains Scene 18; the PROP "red car" must be ready by then.`,
    );
  });

  it("recognises an equivalent requirement that already exists and stops there", () => {
    const index = indexProduction({
      ...createDemoMovie(),
      requirements: [
        ...createDemoMovie().requirements,
        {
          id: "REQ-009",
          productionId: DEMO_MOVIE_IDS.production,
          sceneId: scenes.s18,
          type: "PROP",
          name: "Red  Car",
          status: "NEEDED",
        },
      ],
    });

    const repeat = analyzeImpact(index, redCarForScene18);
    expect(repeat.impacts.map(shape)).toEqual([["INFO", "REQUIREMENT", "REQ-009"]]);
    expect(repeat.impacts[0]?.reasonCode).toBe("SCENE_REQUIREMENT_ALREADY_PRESENT");
    expect(repeat.conflicts).toEqual([]);
  });
});

describe("scope discipline", () => {
  it("reports nothing when the unavailable day carries none of the cast member's scenes", () => {
    const analysis = analyzeImpact(demo(), {
      ...sarahOnFriday,
      unavailable: { start: monday, end: monday },
    });

    expect(analysis).toEqual({ impacts: [], conflicts: [], affectedEntityIds: [] });
  });

  it("reaches scenes on every day inside a multi-day window", () => {
    const analysis = analyzeImpact(demo(), {
      type: "CAST_UNAVAILABLE",
      castId: cast.john,
      unavailable: { start: friday, end: monday },
    });

    expect(analysis.conflicts.map((conflict) => [conflict.entityId, conflict.date])).toEqual([
      [scenes.s07, friday],
      [scenes.s22, monday],
    ]);
  });

  it("skips tasks that are already done", () => {
    const analysis = analyzeImpact(demo(), warehouseOnFriday);
    expect(analysis.affectedEntityIds).not.toContain("T-004");
  });

  it("is a pure function of its inputs", () => {
    expect(analyzeImpact(demo(), sarahOnFriday)).toEqual(analyzeImpact(demo(), sarahOnFriday));
  });

  it("does not mutate the snapshot it reads", () => {
    const index = demo();
    const before = JSON.stringify(index.state);
    analyzeImpact(index, warehouseOnFriday);
    expect(JSON.stringify(index.state)).toBe(before);
  });

  it("answers an unknown reference with a conflict rather than a throw", () => {
    const analysis = analyzeImpact(demo(), { ...sarahOnFriday, castId: "CAST-GHOST" });
    expect(analysis.impacts).toEqual([]);
    expect(analysis.conflicts).toEqual([
      {
        code: "UNKNOWN_ENTITY_REFERENCE",
        entityType: "CAST_MEMBER",
        entityId: "CAST-GHOST",
        detail: "CAST_MEMBER CAST-GHOST does not exist in this production.",
      },
    ]);
  });
});

describe("SCHEDULE_CHANGED: moving the Warehouse scenes to Monday", () => {
  const move: TypedChange = {
    type: "SCHEDULE_CHANGED",
    sceneIds: [scenes.s07, scenes.s12],
    toShootDayId: shootDays.monday,
  };

  it("warns about who and what Monday now needs, and flags both days' call sheets", () => {
    const analysis = analyzeImpact(demo(), move);
    expect(analysis.impacts.map(shape)).toEqual([
      ["WARNING", "CAST_MEMBER", cast.john],
      ["WARNING", "CAST_MEMBER", cast.sarah],
      ["WARNING", "LOCATION", locations.warehouse],
      ["WARNING", "SHOOT_DAY", shootDays.friday],
      ["WARNING", "SHOOT_DAY", shootDays.monday],
      ["WARNING", "CALL_SHEET", callSheets.friday],
      ["WARNING", "CALL_SHEET", callSheets.monday],
      ["INFO", "SCENE", scenes.s07],
      ["INFO", "SCENE", scenes.s12],
      ["INFO", "TASK", "T-001"],
      ["INFO", "TASK", "T-002"],
      ["INFO", "TASK", "T-003"],
    ]);
    expect(analysis.conflicts).toEqual([]);
  });

  it("phrases the Monday warning the way the proposal view shows it", () => {
    const john = analyzeImpact(demo(), move).impacts.find(
      (impact) => impact.entityId === cast.john,
    );
    expect(john?.explanation).toBe("John is required on 2026-09-21 for Scene 07.");
  });

  it("blocks a move onto a day the cast member cannot make", () => {
    const state = createDemoMovie();
    const blocked = indexProduction({
      ...state,
      castMembers: state.castMembers.map((member) =>
        member.id === cast.sarah
          ? { ...member, unavailable: [{ start: monday, end: monday }] }
          : member,
      ),
    });

    const analysis = analyzeImpact(blocked, move);
    expect(analysis.impacts[0]).toMatchObject({
      severity: "BLOCKING",
      entityType: "CAST_MEMBER",
      entityId: cast.sarah,
      reasonCode: "CAST_REQUIRED_ON_TARGET_DAY",
    });
    expect(analysis.conflicts.map((conflict) => [conflict.code, conflict.entityId])).toEqual([
      ["CAST_UNAVAILABLE_ON_SHOOT_DAY", scenes.s07],
      ["CAST_UNAVAILABLE_ON_SHOOT_DAY", scenes.s12],
    ]);
  });

  it("treats a scene already on the target day as a conflict, not a move", () => {
    const analysis = analyzeImpact(demo(), {
      type: "SCHEDULE_CHANGED",
      sceneIds: [scenes.s22],
      toShootDayId: shootDays.monday,
    });

    expect(analysis.impacts).toEqual([]);
    expect(analysis.conflicts.map((conflict) => conflict.code)).toEqual([
      "SCENE_ALREADY_ON_SHOOT_DAY",
    ]);
  });
});
