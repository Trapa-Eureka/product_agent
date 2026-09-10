import { describe, expect, it } from "vitest";

import {
  dateRangeSchema,
  entityIdSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  localDateSchema,
  productionVersionSchema,
  proposalDigestSchema,
  timezoneSchema,
} from "../src/primitives";

describe("entityIdSchema", () => {
  it.each(["S07", "CAST-SARAH", "SD-2026-09-18", "prod.demo:1"])("accepts %s", (id) => {
    expect(entityIdSchema.safeParse(id).success).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["leading hyphen", "-S07"],
    ["whitespace", "S 07"],
    ["path traversal", "../etc/passwd"],
    ["mongo operator", "$where"],
  ])("rejects %s", (_label, id) => {
    expect(entityIdSchema.safeParse(id).success).toBe(false);
  });
});

describe("localDateSchema", () => {
  it("accepts a production-local calendar date", () => {
    expect(localDateSchema.safeParse("2026-09-18").success).toBe(true);
  });

  it.each([
    ["a timestamp", "2026-09-18T10:00:00.000Z"],
    ["an unpadded month", "2026-9-18"],
    ["an impossible month", "2026-13-01"],
    ["a day that does not exist", "2026-02-30"],
    ["a locale format", "18/09/2026"],
  ])("rejects %s", (_label, value) => {
    expect(localDateSchema.safeParse(value).success).toBe(false);
  });
});

describe("isoDateTimeSchema", () => {
  it("accepts a UTC instant", () => {
    expect(isoDateTimeSchema.safeParse("2026-09-18T10:00:00.000Z").success).toBe(true);
  });

  it("rejects a bare calendar date", () => {
    expect(isoDateTimeSchema.safeParse("2026-09-18").success).toBe(false);
  });
});

describe("timezoneSchema", () => {
  it("accepts the Demo Movie timezone", () => {
    expect(timezoneSchema.safeParse("Asia/Manila").success).toBe(true);
  });

  it("rejects a name the runtime does not know", () => {
    expect(timezoneSchema.safeParse("Mars/Olympus_Mons").success).toBe(false);
  });
});

describe("dateRangeSchema", () => {
  it("accepts a single-day range", () => {
    expect(dateRangeSchema.safeParse({ start: "2026-09-18", end: "2026-09-18" }).success).toBe(
      true,
    );
  });

  it("rejects a range that ends before it starts", () => {
    const result = dateRangeSchema.safeParse({ start: "2026-09-21", end: "2026-09-18" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["end"]);
  });

  it("rejects unknown keys so a misspelled field is never silently ignored", () => {
    expect(
      dateRangeSchema.safeParse({ start: "2026-09-18", end: "2026-09-18", reason: "flu" }).success,
    ).toBe(false);
  });
});

describe("version, digest, and idempotency primitives", () => {
  it("accepts an initial production version of zero", () => {
    expect(productionVersionSchema.safeParse(0).success).toBe(true);
  });

  it.each([
    ["a negative version", -1],
    ["a fractional version", 1.5],
  ])("rejects %s", (_label, value) => {
    expect(productionVersionSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a lowercase hex sha-256 digest", () => {
    expect(proposalDigestSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it.each([
    ["an uppercase digest", "A".repeat(64)],
    ["a truncated digest", "a".repeat(63)],
  ])("rejects %s", (_label, value) => {
    expect(proposalDigestSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a guessable short idempotency key", () => {
    expect(idempotencyKeySchema.safeParse("abc").success).toBe(false);
  });
});
