import { describe, expect, it } from "vitest";

import { changeRequestSchema, typedChangeSchema } from "../src/change";

const castUnavailable = {
  type: "CAST_UNAVAILABLE",
  castId: "CAST-SARAH",
  unavailable: { start: "2026-09-18", end: "2026-09-18" },
} as const;

describe("typedChangeSchema", () => {
  it("accepts each MVP change type", () => {
    const changes = [
      castUnavailable,
      {
        type: "LOCATION_UNAVAILABLE",
        locationId: "LOC-WAREHOUSE",
        unavailable: { start: "2026-09-18", end: "2026-09-18" },
      },
      {
        type: "SCENE_REQUIREMENT_CHANGED",
        sceneId: "S18",
        requirement: { type: "PROP", name: "red car" },
      },
      { type: "SCHEDULE_CHANGED", sceneIds: ["S07"], toShootDayId: "SD-2026-09-21" },
    ];

    for (const change of changes) {
      expect(typedChangeSchema.safeParse(change).success).toBe(true);
    }
  });

  it("rejects an unknown change type", () => {
    expect(
      typedChangeSchema.safeParse({ type: "CAST_PROMOTED", castId: "CAST-SARAH" }).success,
    ).toBe(false);
  });

  it("rejects a change that carries a name instead of a resolved ID", () => {
    expect(
      typedChangeSchema.safeParse({
        type: "CAST_UNAVAILABLE",
        castName: "Sarah",
        unavailable: { start: "2026-09-18", end: "2026-09-18" },
      }).success,
    ).toBe(false);
  });

  it("rejects a schedule change that moves no scenes", () => {
    expect(
      typedChangeSchema.safeParse({
        type: "SCHEDULE_CHANGED",
        sceneIds: [],
        toShootDayId: "SD-2026-09-21",
      }).success,
    ).toBe(false);
  });
});

describe("changeRequestSchema", () => {
  const base = {
    id: "CR-001",
    productionId: "PROD-DEMO",
    type: "CAST_UNAVAILABLE",
    rawText: "Sarah cannot shoot Friday.",
    payload: castUnavailable,
    correlationId: "corr-001",
    createdBy: "coordinator@example.test",
    createdAt: "2026-09-10T11:03:00.000Z",
  };

  it("accepts a request whose type agrees with its payload", () => {
    expect(changeRequestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a request whose declared type contradicts its payload", () => {
    const result = changeRequestSchema.safeParse({ ...base, type: "LOCATION_UNAVAILABLE" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must match");
  });

  it("rejects an empty raw text, since intake must record what the user said", () => {
    expect(changeRequestSchema.safeParse({ ...base, rawText: "" }).success).toBe(false);
  });

  it("requires a correlation ID so the request can be traced across boundaries", () => {
    const { correlationId: _omitted, ...withoutCorrelationId } = base;
    expect(changeRequestSchema.safeParse(withoutCorrelationId).success).toBe(false);
  });
});
