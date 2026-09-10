import { describe, expect, it } from "vitest";

import {
  blockedDatesWithin,
  eachDateBetween,
  isBlockedOn,
  isDateWithin,
  normalizeDateRanges,
} from "../src/dates";

describe("isDateWithin", () => {
  const range = { start: "2026-09-18", end: "2026-09-21" };

  it.each(["2026-09-18", "2026-09-19", "2026-09-21"])("includes %s", (date) => {
    expect(isDateWithin(date, range)).toBe(true);
  });

  it.each(["2026-09-17", "2026-09-22"])("excludes %s", (date) => {
    expect(isDateWithin(date, range)).toBe(false);
  });
});

describe("isBlockedOn", () => {
  it("returns false when there are no windows", () => {
    expect(isBlockedOn([], "2026-09-18")).toBe(false);
  });

  it("returns true when any window covers the date", () => {
    expect(
      isBlockedOn(
        [
          { start: "2026-09-01", end: "2026-09-02" },
          { start: "2026-09-18", end: "2026-09-18" },
        ],
        "2026-09-18",
      ),
    ).toBe(true);
  });
});

describe("eachDateBetween", () => {
  it("includes both ends", () => {
    expect(eachDateBetween("2026-09-18", "2026-09-21")).toEqual([
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
    ]);
  });

  it("returns a single day for a same-day range", () => {
    expect(eachDateBetween("2026-09-18", "2026-09-18")).toEqual(["2026-09-18"]);
  });

  it("crosses a month boundary", () => {
    expect(eachDateBetween("2026-09-30", "2026-10-01")).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("handles a leap day", () => {
    expect(eachDateBetween("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("refuses a range that runs backwards", () => {
    expect(() => eachDateBetween("2026-09-21", "2026-09-18")).toThrow(/before its start/u);
  });

  it("refuses to enumerate an unbounded window", () => {
    expect(() => eachDateBetween("2026-01-01", "2030-01-01")).toThrow(/limit is 366/u);
  });

  it("rejects a value that is not a production-local date", () => {
    expect(() => eachDateBetween("2026-09-18T00:00:00Z", "2026-09-19")).toThrow(/YYYY-MM-DD/u);
  });
});

describe("blockedDatesWithin", () => {
  it("lists blocked days explicitly rather than leaving gaps to be inferred", () => {
    expect(
      blockedDatesWithin(
        [
          { start: "2026-09-18", end: "2026-09-19" },
          { start: "2026-09-22", end: "2026-09-22" },
        ],
        "2026-09-17",
        "2026-09-23",
      ),
    ).toEqual(["2026-09-18", "2026-09-19", "2026-09-22"]);
  });

  it("returns nothing when the window is entirely free", () => {
    expect(blockedDatesWithin([], "2026-09-17", "2026-09-23")).toEqual([]);
  });
});

describe("normalizeDateRanges", () => {
  it("merges overlapping windows", () => {
    expect(
      normalizeDateRanges([
        { start: "2026-09-18", end: "2026-09-20" },
        { start: "2026-09-19", end: "2026-09-22" },
      ]),
    ).toEqual([{ start: "2026-09-18", end: "2026-09-22" }]);
  });

  it("merges windows that are merely adjacent", () => {
    expect(
      normalizeDateRanges([
        { start: "2026-09-18", end: "2026-09-18" },
        { start: "2026-09-19", end: "2026-09-19" },
      ]),
    ).toEqual([{ start: "2026-09-18", end: "2026-09-19" }]);
  });

  it("keeps windows separated by a free day apart", () => {
    expect(
      normalizeDateRanges([
        { start: "2026-09-18", end: "2026-09-18" },
        { start: "2026-09-20", end: "2026-09-20" },
      ]),
    ).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const windows = [{ start: "2026-09-19", end: "2026-09-19" }];
    normalizeDateRanges(windows);
    expect(windows).toEqual([{ start: "2026-09-19", end: "2026-09-19" }]);
  });
});
