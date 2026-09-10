import { describe, expect, it } from "vitest";

import {
  formatChangeType,
  formatDateRange,
  formatLocalDate,
  formatTypedChange,
  summarizeTypedChange,
} from "./typed-change-format";

describe("formatLocalDate", () => {
  it("names the weekday and month without shifting the calendar date", () => {
    expect(formatLocalDate("2026-09-18")).toBe("Fri, Sep 18, 2026");
    expect(formatLocalDate("2026-01-01")).toBe("Thu, Jan 1, 2026");
  });

  it("returns an unparseable value unchanged", () => {
    expect(formatLocalDate("not-a-date")).toBe("not-a-date");
  });
});

describe("formatDateRange", () => {
  it("reads a single day as one date and a span as a range", () => {
    expect(formatDateRange({ start: "2026-09-18", end: "2026-09-18" })).toBe("Fri, Sep 18, 2026");
    expect(formatDateRange({ start: "2026-09-18", end: "2026-09-21" })).toBe(
      "Fri, Sep 18, 2026 – Mon, Sep 21, 2026",
    );
  });
});

describe("formatChangeType", () => {
  it("names every change type in plain English", () => {
    expect(formatChangeType("CAST_UNAVAILABLE")).toBe("Cast unavailable");
    expect(formatChangeType("LOCATION_UNAVAILABLE")).toBe("Location unavailable");
    expect(formatChangeType("SCENE_REQUIREMENT_CHANGED")).toBe("Scene requirement changed");
    expect(formatChangeType("SCHEDULE_CHANGED")).toBe("Schedule changed");
  });
});

describe("formatTypedChange", () => {
  it("GOLDEN-1: cast unavailability names the cast ID and the date", () => {
    const formatted = formatTypedChange({
      type: "CAST_UNAVAILABLE",
      castId: "CAST-SARAH",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    });
    expect(formatted.typeLabel).toBe("Cast unavailable");
    expect(formatted.fields).toEqual([
      { label: "Cast", value: "CAST-SARAH" },
      { label: "Unavailable", value: "Fri, Sep 18, 2026" },
    ]);
  });

  it("GOLDEN-2: location unavailability names the location ID and the date", () => {
    const formatted = formatTypedChange({
      type: "LOCATION_UNAVAILABLE",
      locationId: "LOC-WAREHOUSE",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    });
    expect(formatted.fields).toEqual([
      { label: "Location", value: "LOC-WAREHOUSE" },
      { label: "Unavailable", value: "Fri, Sep 18, 2026" },
    ]);
  });

  it("GOLDEN-3: a requirement change names the scene and the requirement", () => {
    const formatted = formatTypedChange({
      type: "SCENE_REQUIREMENT_CHANGED",
      sceneId: "S18",
      requirement: { type: "PROP", name: "red car" },
    });
    expect(formatted.fields).toEqual([
      { label: "Scene", value: "S18" },
      { label: "Prop", value: "red car" },
    ]);
  });

  it("a schedule change names the scenes (plural when more than one) and the target day", () => {
    const one = formatTypedChange({
      type: "SCHEDULE_CHANGED",
      sceneIds: ["S07"],
      toShootDayId: "SD-2026-09-21",
    });
    expect(one.fields[0]).toEqual({ label: "Scene", value: "S07" });
    const many = formatTypedChange({
      type: "SCHEDULE_CHANGED",
      sceneIds: ["S07", "S12"],
      toShootDayId: "SD-2026-09-21",
    });
    expect(many.fields[0]).toEqual({ label: "Scenes", value: "S07, S12" });
    expect(many.fields[1]).toEqual({ label: "To shoot day", value: "SD-2026-09-21" });
  });
});

describe("summarizeTypedChange", () => {
  it("joins the fields into one line", () => {
    expect(
      summarizeTypedChange({
        type: "CAST_UNAVAILABLE",
        castId: "CAST-SARAH",
        unavailable: { start: "2026-09-18", end: "2026-09-18" },
      }),
    ).toBe("Cast: CAST-SARAH · Unavailable: Fri, Sep 18, 2026");
  });
});
