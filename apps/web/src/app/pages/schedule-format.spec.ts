import { describe, expect, it } from "vitest";

import type { ShootDay } from "@pca/contracts";

import { buildScheduleRows, type NormalizedScene } from "./schedule-format";

const scene = (overrides: Partial<NormalizedScene["scene"]> = {}): NormalizedScene => ({
  scene: {
    id: "SCENE-07",
    productionId: "PROD-DEMO",
    sceneNumber: "07",
    title: "Standoff at the loading dock",
    locationId: "LOC-WAREHOUSE",
    requiredCastIds: ["CAST-SARAH", "CAST-JOHN"],
    requirementIds: [],
    estimatedMinutes: 120,
    ...overrides,
  },
  location: { id: "LOC-WAREHOUSE", productionId: "PROD-DEMO", name: "Warehouse", unavailable: [] },
  requiredCast: [
    { id: "CAST-SARAH", productionId: "PROD-DEMO", name: "Sarah", unavailable: [] },
    { id: "CAST-JOHN", productionId: "PROD-DEMO", name: "John", unavailable: [] },
  ],
  requirements: [],
  scheduledShootDayId: "SD-0918",
});

const shootDay = (overrides: Partial<ShootDay> = {}): ShootDay => ({
  id: "SD-0918",
  productionId: "PROD-DEMO",
  date: "2026-09-18",
  sceneIds: ["SCENE-07"],
  status: "CONFIRMED",
  ...overrides,
});

describe("buildScheduleRows", () => {
  it("sorts shoot days earliest first, regardless of input order", () => {
    const rows = buildScheduleRows(
      [shootDay({ id: "SD-B", date: "2026-09-22" }), shootDay({ id: "SD-A", date: "2026-09-18" })],
      new Map(),
    );
    expect(rows.map((row) => row.shootDayId)).toEqual(["SD-A", "SD-B"]);
  });

  it("formats the date and carries the status through", () => {
    const rows = buildScheduleRows([shootDay()], new Map());
    expect(rows[0]?.date).toBe("Fri, Sep 18, 2026");
    expect(rows[0]?.status).toBe("CONFIRMED");
  });

  it("labels a resolved scene by number, title, location, and required cast", () => {
    const rows = buildScheduleRows([shootDay()], new Map([["SCENE-07", scene()]]));
    expect(rows[0]?.scenes).toEqual([
      {
        sceneId: "SCENE-07",
        label: "Scene 07 — Standoff at the loading dock",
        locationName: "Warehouse",
        castNames: ["Sarah", "John"],
      },
    ]);
  });

  it("labels a scene with no title by number alone", () => {
    const withoutTitle = scene({ title: undefined });
    const rows = buildScheduleRows([shootDay()], new Map([["SCENE-07", withoutTitle]]));
    expect(rows[0]?.scenes[0]?.label).toBe("Scene 07");
  });

  it("shows an unresolved scene honestly by its ID rather than dropping it", () => {
    const rows = buildScheduleRows([shootDay()], new Map());
    expect(rows[0]?.scenes).toEqual([
      { sceneId: "SCENE-07", label: "Scene SCENE-07", locationName: null, castNames: [] },
    ]);
  });

  it("gives a day with no scenes an empty list, not an error", () => {
    const rows = buildScheduleRows([shootDay({ sceneIds: [] })], new Map());
    expect(rows[0]?.scenes).toEqual([]);
  });
});
