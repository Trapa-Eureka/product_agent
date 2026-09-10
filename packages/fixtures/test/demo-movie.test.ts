import { describe, expect, it } from "vitest";

import {
  callSheetSchema,
  castMemberSchema,
  locationSchema,
  productionSchema,
  requirementSchema,
  sceneSchema,
  shootDaySchema,
  taskSchema,
} from "@pca/contracts";
import {
  checkStateInvariants,
  indexProduction,
  isBlockedOn,
  scheduledShootDay,
  type ProductionState,
} from "@pca/domain";
import { onDay, withCastUnavailable, withLocationUnavailable } from "@pca/test-support";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "../src";

const { cast, callSheets, locations, requirements, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;

const asState = (fixture: ReturnType<typeof createDemoMovie>): ProductionState => fixture;

const index = () => indexProduction(asState(createDemoMovie()));

describe("Demo Movie identity", () => {
  it("keeps the published IDs stable, because tests, seeds, and demos name them", () => {
    expect(DEMO_MOVIE_IDS).toEqual({
      production: "PROD-DEMO",
      cast: { sarah: "CAST-SARAH", john: "CAST-JOHN", mike: "CAST-MIKE" },
      locations: {
        warehouse: "LOC-WAREHOUSE",
        cafe: "LOC-CAFE",
        apartment: "LOC-APARTMENT",
      },
      scenes: { s07: "S07", s12: "S12", s18: "S18", s22: "S22" },
      shootDays: {
        friday: "SD-2026-09-18",
        monday: "SD-2026-09-21",
        tuesday: "SD-2026-09-22",
      },
      callSheets: {
        friday: "CS-2026-09-18",
        monday: "CS-2026-09-21",
        tuesday: "CS-2026-09-22",
      },
      requirements: { crowbar: "REQ-001", raincoat: "REQ-002" },
      tasks: {
        confirmFridayCrewCall: "T-001",
        distributeFridayCallSheet: "T-002",
        prepCrowbar: "T-003",
        collectRaincoat: "T-004",
      },
    });
  });

  it("names shoot dates that really fall on the weekdays the scenarios use", () => {
    const weekdayOf = (date: string): string =>
      new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "UTC",
      });

    expect(weekdayOf(friday)).toBe("Friday");
    expect(weekdayOf(monday)).toBe("Monday");
    expect(weekdayOf(tuesday)).toBe("Tuesday");
  });

  it("matches the cast, locations, and scenes listed in TESTING.md", () => {
    const fixture = createDemoMovie();
    expect(fixture.production.name).toBe("Demo Movie");
    expect(fixture.production.timezone).toBe("Asia/Manila");
    expect(fixture.castMembers.map((member) => member.name)).toEqual(["Sarah", "John", "Mike"]);
    expect(fixture.locations.map((location) => location.name)).toEqual([
      "Warehouse",
      "Cafe",
      "Apartment",
    ]);
    expect(fixture.scenes.map((scene) => scene.sceneNumber)).toEqual(["07", "12", "18", "22"]);
  });
});

describe("Demo Movie validates against the shared contracts", () => {
  /**
   * TypeScript proves the fixture has the right fields. Only the schemas prove
   * the values are legal: the ID pattern, a positive scene duration, a real IANA
   * timezone, a UTC timestamp. A fixture that cannot survive its own contracts
   * would fail later at a boundary instead of here.
   */
  const fixture = createDemoMovie();

  it("has a valid production record", () => {
    expect(productionSchema.safeParse(fixture.production).success).toBe(true);
  });

  it.each([
    ["scenes", sceneSchema, fixture.scenes],
    ["castMembers", castMemberSchema, fixture.castMembers],
    ["locations", locationSchema, fixture.locations],
    ["requirements", requirementSchema, fixture.requirements],
    ["shootDays", shootDaySchema, fixture.shootDays],
    ["callSheets", callSheetSchema, fixture.callSheets],
    ["tasks", taskSchema, fixture.tasks],
  ] as const)("has valid %s", (_label, schema, records) => {
    for (const record of records) {
      const result = schema.safeParse(record);
      expect(result.error?.issues ?? [], JSON.stringify(record)).toEqual([]);
      expect(result.success).toBe(true);
    }
  });
});

describe("Demo Movie is internally consistent", () => {
  it("passes every domain invariant before any scenario touches it", () => {
    expect(checkStateInvariants(index())).toEqual([]);
  });

  it("hands out a fresh copy each time, so one test cannot corrupt another", () => {
    const first = createDemoMovie();
    first.scenes.length = 0;
    expect(createDemoMovie().scenes).toHaveLength(4);
  });

  it("schedules every scene exactly once", () => {
    const built = index();
    for (const scene of built.state.scenes) {
      expect(built.shootDaysBySceneId.get(scene.id) ?? [], scene.id).toHaveLength(1);
    }
  });

  it("gives every shoot day a call sheet, so downstream impact is always visible", () => {
    const built = index();
    for (const shootDay of built.state.shootDays) {
      expect(built.callSheetsByShootDayId.get(shootDay.id) ?? [], shootDay.id).toHaveLength(1);
    }
  });
});

/**
 * TESTING.md §3 lists six conditions the fixture must satisfy. Each is asserted
 * here on its own, so a fixture edit that quietly breaks a golden scenario fails
 * with the name of the condition it broke rather than deep inside a scenario
 * test.
 */
describe("required fixture conditions (TESTING.md §3)", () => {
  it("schedules S07 and S12 on Friday", () => {
    const built = index();
    const fridayDay = built.shootDayById.get(shootDays.friday);
    expect(fridayDay?.date).toBe(friday);
    expect(fridayDay?.sceneIds).toEqual([scenes.s07, scenes.s12]);
  });

  it("leaves Sarah available on Friday", () => {
    const sarah = index().castById.get(cast.sarah);
    expect(sarah).toBeDefined();
    expect(isBlockedOn(sarah?.unavailable ?? [], friday)).toBe(false);
  });

  it("leaves the Warehouse available on Friday", () => {
    const warehouse = index().locationById.get(locations.warehouse);
    expect(warehouse).toBeDefined();
    expect(isBlockedOn(warehouse?.unavailable ?? [], friday)).toBe(false);
  });

  it("makes Monday a genuine alternative for the Warehouse scenes", () => {
    const built = index();
    const warehouse = built.locationById.get(locations.warehouse);
    const sarah = built.castById.get(cast.sarah);
    const john = built.castById.get(cast.john);

    expect(isBlockedOn(warehouse?.unavailable ?? [], monday)).toBe(false);
    expect(isBlockedOn(sarah?.unavailable ?? [], monday)).toBe(false);
    expect(isBlockedOn(john?.unavailable ?? [], monday)).toBe(false);
    expect(built.shootDayById.get(shootDays.monday)?.date).toBe(monday);
  });

  it("gives S18 no red-car requirement, so adding one is a real change", () => {
    const built = index();
    const scene18 = built.sceneById.get(scenes.s18);
    expect(scene18?.requirementIds).toEqual([]);
    expect(
      built.state.requirements.some((requirement) =>
        requirement.name.toLowerCase().includes("car"),
      ),
    ).toBe(false);
  });

  it("links a call sheet to the Friday shoot day", () => {
    const built = index();
    const sheet = built.callSheetById.get(callSheets.friday);
    expect(sheet?.shootDayId).toBe(shootDays.friday);
    expect(sheet?.status).toBe("PUBLISHED");
  });
});

/**
 * The preconditions above say what the fixture contains. These say the fixture
 * actually behaves the way each golden scenario needs, by introducing the
 * scenario's conflict and checking the domain notices exactly the right scenes.
 */
describe("golden scenario preconditions behave as intended", () => {
  it("GOLDEN-1: blocking Sarah on Friday conflicts with S07 and S12 only", () => {
    const blocked = withCastUnavailable(createDemoMovie(), cast.sarah, onDay(friday));
    const violations = checkStateInvariants(indexProduction(asState(blocked)));

    expect(violations.map((violation) => violation.invariant)).toEqual(["INV-1", "INV-1"]);
    expect(violations.map((violation) => violation.conflict.entityId).sort()).toEqual([
      scenes.s07,
      scenes.s12,
    ]);
  });

  it("GOLDEN-2: blocking the Warehouse on Friday conflicts with S07 and S12 only", () => {
    const blocked = withLocationUnavailable(createDemoMovie(), locations.warehouse, onDay(friday));
    const violations = checkStateInvariants(indexProduction(asState(blocked)));

    expect(violations.map((violation) => violation.invariant)).toEqual(["INV-2", "INV-2"]);
    expect(violations.map((violation) => violation.conflict.entityId).sort()).toEqual([
      scenes.s07,
      scenes.s12,
    ]);
  });

  it("GOLDEN-2: the affected Warehouse scenes involve both Sarah and John", () => {
    const built = index();
    const involved = new Set(
      [scenes.s07, scenes.s12].flatMap(
        (sceneId) => built.sceneById.get(sceneId)?.requiredCastIds ?? [],
      ),
    );

    expect([...involved].sort()).toEqual([cast.john, cast.sarah].sort());
  });

  it("GOLDEN-3: S18 sits on a scheduled day with a call sheet, so a change has somewhere to land", () => {
    const built = index();
    const day = scheduledShootDay(built, scenes.s18);

    expect(day?.id).toBe(shootDays.tuesday);
    expect(built.callSheetsByShootDayId.get(shootDays.tuesday) ?? []).toHaveLength(1);
  });

  it("keeps John busy on Monday, which is the warning the proposal must surface", () => {
    const built = index();
    const mondayScenes = built.shootDayById.get(shootDays.monday)?.sceneIds ?? [];
    const mondayCast = mondayScenes.flatMap(
      (sceneId) => built.sceneById.get(sceneId)?.requiredCastIds ?? [],
    );

    expect(mondayCast).toContain(cast.john);
  });

  it("keeps the requirement fixture free of the name Scenario C introduces", () => {
    expect(createDemoMovie().requirements.map((requirement) => requirement.id)).toEqual([
      requirements.crowbar,
      requirements.raincoat,
    ]);
  });
});
