import { describe, expect, it } from "vitest";

import {
  interpretChangeInputSchema,
  interpretedChangeSchema,
  rankedCandidatesOutputSchema,
} from "../src/model";

const change = {
  type: "CAST_UNAVAILABLE",
  castId: "CAST-SARAH",
  unavailable: { start: "2026-09-18", end: "2026-09-18" },
};

describe("interpretChangeInputSchema", () => {
  it("requires the context a model needs to resolve names and weekdays", () => {
    expect(
      interpretChangeInputSchema.safeParse({
        productionId: "PROD-DEMO",
        text: "Sarah cannot shoot Friday.",
        context: {
          castMembers: [{ id: "CAST-SARAH", name: "Sarah" }],
          locations: [],
          scenes: [],
          shootDays: [{ id: "SD-2026-09-18", date: "2026-09-18" }],
          today: "2026-09-10",
        },
      }).success,
    ).toBe(true);
    expect(
      interpretChangeInputSchema.safeParse({
        productionId: "PROD-DEMO",
        text: "Sarah cannot shoot Friday.",
      }).success,
    ).toBe(false);
  });
});

describe("interpretedChangeSchema", () => {
  it("accepts each documented kind", () => {
    expect(
      interpretedChangeSchema.safeParse({ kind: "RESOLVED", change, confidence: 0.8 }).success,
    ).toBe(true);
    expect(
      interpretedChangeSchema.safeParse({
        kind: "AMBIGUOUS",
        question: "Which Sarah?",
        options: [
          { label: "a", change },
          { label: "b", change },
        ],
      }).success,
    ).toBe(true);
    expect(
      interpretedChangeSchema.safeParse({ kind: "UNSUPPORTED", reason: "Not a production change." })
        .success,
    ).toBe(true);
  });

  it("rejects a resolution that carries a name instead of an ID", () => {
    expect(
      interpretedChangeSchema.safeParse({
        kind: "RESOLVED",
        change: { type: "CAST_UNAVAILABLE", castName: "Sarah" },
        confidence: 0.8,
      }).success,
    ).toBe(false);
  });

  it("rejects chain-of-thought smuggled in as an extra field", () => {
    expect(
      interpretedChangeSchema.safeParse({
        kind: "RESOLVED",
        change,
        confidence: 0.8,
        reasoning: "...",
      }).success,
    ).toBe(false);
  });
});

describe("rankedCandidatesOutputSchema", () => {
  it("requires a reason for every rank", () => {
    expect(
      rankedCandidatesOutputSchema.safeParse({
        ranked: [{ shootDayId: "SD-1", rank: 1, reason: "free" }],
      }).success,
    ).toBe(true);
    expect(
      rankedCandidatesOutputSchema.safeParse({ ranked: [{ shootDayId: "SD-1", rank: 1 }] }).success,
    ).toBe(false);
    expect(rankedCandidatesOutputSchema.safeParse({ ranked: [] }).success).toBe(false);
  });
});
