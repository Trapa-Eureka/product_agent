import { describe, expect, it } from "vitest";

import { indexProduction } from "../src/production-state";
import {
  checkCastAvailability,
  checkLocationAvailability,
  checkProductionIsolation,
  checkSceneIntegrity,
  checkStateInvariants,
  isProductionStateValid,
} from "../src/invariants/state";
import {
  aCallSheet,
  aCastMember,
  aLocation,
  aProductionState,
  aRequirement,
  aScene,
  aShootDay,
  aTask,
} from "./builders";

const FRIDAY = "2026-09-18";
const MONDAY = "2026-09-21";

describe("INV-1 cast availability", () => {
  it("accepts a scene scheduled on a day its cast is available", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", requiredCastIds: ["CAST-SARAH"] })],
        castMembers: [aCastMember()],
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: ["S07"] })],
      }),
    );

    expect(checkCastAvailability(index)).toEqual([]);
  });

  it("rejects a scene scheduled on a day its required cast is unavailable", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", sceneNumber: "07", requiredCastIds: ["CAST-SARAH"] })],
        castMembers: [aCastMember({ unavailable: [{ start: FRIDAY, end: FRIDAY }] })],
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: ["S07"] })],
      }),
    );

    const violations = checkCastAvailability(index);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.invariant).toBe("INV-1");
    expect(violations[0]?.conflict.code).toBe("CAST_UNAVAILABLE_ON_SHOOT_DAY");
    expect(violations[0]?.conflict.entityId).toBe("S07");
    expect(violations[0]?.conflict.date).toBe(FRIDAY);
    expect(violations[0]?.conflict.detail).toContain("Sarah");
  });

  it("reports one violation per unavailable cast member on the scene", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", requiredCastIds: ["CAST-SARAH", "CAST-JOHN"] })],
        castMembers: [
          aCastMember({ unavailable: [{ start: FRIDAY, end: FRIDAY }] }),
          aCastMember({
            id: "CAST-JOHN",
            name: "John",
            unavailable: [{ start: FRIDAY, end: MONDAY }],
          }),
        ],
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: ["S07"] })],
      }),
    );

    expect(checkCastAvailability(index)).toHaveLength(2);
  });

  it("ignores an unavailable cast member when the scene is not scheduled", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", requiredCastIds: ["CAST-SARAH"] })],
        castMembers: [aCastMember({ unavailable: [{ start: FRIDAY, end: FRIDAY }] })],
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: [] })],
      }),
    );

    expect(checkCastAvailability(index)).toEqual([]);
  });

  it("treats a multi-day unavailability window as inclusive of both ends", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", requiredCastIds: ["CAST-SARAH"] })],
        castMembers: [aCastMember({ unavailable: [{ start: FRIDAY, end: MONDAY }] })],
        locations: [aLocation()],
        shootDays: [aShootDay({ id: "SD-MON", date: MONDAY, sceneIds: ["S07"] })],
      }),
    );

    expect(checkCastAvailability(index)).toHaveLength(1);
  });
});

describe("INV-2 location availability", () => {
  it("rejects a scene scheduled at a location that is unavailable that day", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", sceneNumber: "07", locationId: "LOC-WAREHOUSE" })],
        locations: [
          aLocation({
            id: "LOC-WAREHOUSE",
            name: "Warehouse",
            unavailable: [{ start: FRIDAY, end: FRIDAY }],
          }),
        ],
        shootDays: [aShootDay({ sceneIds: ["S07"] })],
      }),
    );

    const violations = checkLocationAvailability(index);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.invariant).toBe("INV-2");
    expect(violations[0]?.conflict.code).toBe("LOCATION_UNAVAILABLE_ON_SHOOT_DAY");
    expect(violations[0]?.conflict.detail).toContain("Warehouse");
  });

  it("accepts the same scene on a day the location is free", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", locationId: "LOC-WAREHOUSE" })],
        locations: [
          aLocation({
            id: "LOC-WAREHOUSE",
            name: "Warehouse",
            unavailable: [{ start: FRIDAY, end: FRIDAY }],
          }),
        ],
        shootDays: [aShootDay({ id: "SD-MON", date: MONDAY, sceneIds: ["S07"] })],
      }),
    );

    expect(checkLocationAvailability(index)).toEqual([]);
  });
});

describe("INV-3 scene integrity", () => {
  it("accepts a scene whose references all exist", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ requiredCastIds: ["CAST-SARAH"], requirementIds: ["REQ-1"] })],
        castMembers: [aCastMember()],
        locations: [aLocation()],
        requirements: [aRequirement()],
        shootDays: [aShootDay({ sceneIds: ["S01"] })],
        callSheets: [aCallSheet()],
      }),
    );

    expect(checkSceneIntegrity(index)).toEqual([]);
  });

  it.each([
    ["a location that does not exist", { locationId: "LOC-GHOST" }],
    ["a cast member that does not exist", { requiredCastIds: ["CAST-GHOST"] }],
    ["a requirement that does not exist", { requirementIds: ["REQ-GHOST"] }],
  ])("rejects a scene referencing %s", (_label, overrides) => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene(overrides)],
        castMembers: [aCastMember()],
        locations: [aLocation()],
        requirements: [aRequirement()],
      }),
    );

    const violations = checkSceneIntegrity(index);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.conflict.code).toBe("UNKNOWN_ENTITY_REFERENCE");
  });

  it("rejects a shoot day scheduling a scene that does not exist", () => {
    const index = indexProduction(
      aProductionState({
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: ["S99"] })],
      }),
    );

    const violations = checkSceneIntegrity(index);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.conflict.entityType).toBe("SHOOT_DAY");
  });

  it("rejects a scene scheduled on two shoot days at once", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07" })],
        locations: [aLocation()],
        shootDays: [
          aShootDay({ sceneIds: ["S07"] }),
          aShootDay({ id: "SD-MON", date: MONDAY, sceneIds: ["S07"] }),
        ],
      }),
    );

    const violations = checkSceneIntegrity(index);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.conflict.code).toBe("SCENE_ALREADY_ON_SHOOT_DAY");
    expect(violations[0]?.conflict.detail).toContain(MONDAY);
  });

  it("rejects a call sheet pointing at a shoot day that does not exist", () => {
    const index = indexProduction(
      aProductionState({
        locations: [aLocation()],
        callSheets: [aCallSheet({ shootDayId: "SD-GHOST" })],
      }),
    );

    expect(checkSceneIntegrity(index)[0]?.conflict.entityType).toBe("CALL_SHEET");
  });
});

describe("INV-4 production isolation", () => {
  it("accepts a snapshot whose entities all belong to the production", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene()],
        castMembers: [aCastMember()],
        locations: [aLocation()],
        shootDays: [aShootDay()],
        callSheets: [aCallSheet()],
        tasks: [aTask()],
      }),
    );

    expect(checkProductionIsolation(index)).toEqual([]);
  });

  it("rejects an entity that belongs to another production", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ productionId: "PROD-OTHER" })],
        locations: [aLocation()],
      }),
    );

    const violations = checkProductionIsolation(index);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.invariant).toBe("INV-4");
    expect(violations[0]?.conflict.code).toBe("CROSS_PRODUCTION_REFERENCE");
    expect(violations[0]?.conflict.detail).toContain("PROD-OTHER");
  });

  it("checks every entity kind, not only scenes", () => {
    const index = indexProduction(
      aProductionState({
        locations: [aLocation()],
        tasks: [aTask({ productionId: "PROD-OTHER" })],
      }),
    );

    expect(checkProductionIsolation(index)[0]?.conflict.entityType).toBe("TASK");
  });
});

describe("checkStateInvariants", () => {
  it("reports a clean production as valid", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ requiredCastIds: ["CAST-SARAH"] })],
        castMembers: [aCastMember()],
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: ["S01"] })],
        callSheets: [aCallSheet()],
      }),
    );

    expect(checkStateInvariants(index)).toEqual([]);
    expect(isProductionStateValid(index)).toBe(true);
  });

  it("does not report an availability violation for a cast member that does not exist", () => {
    const index = indexProduction(
      aProductionState({
        scenes: [aScene({ id: "S07", requiredCastIds: ["CAST-GHOST"] })],
        locations: [aLocation()],
        shootDays: [aShootDay({ sceneIds: ["S07"] })],
      }),
    );

    const violations = checkStateInvariants(index);
    expect(violations.map((violation) => violation.invariant)).toEqual(["INV-3"]);
  });
});
