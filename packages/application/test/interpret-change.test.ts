import { beforeEach, describe, expect, it } from "vitest";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";
import { createFakeModelAdapter, fixedClock } from "@pca/test-support";

import {
  createInterpretChange,
  interpretationContextFor,
  localDateIn,
  type InterpretChange,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, locations, scenes } = DEMO_MOVIE_IDS;
const { friday } = DEMO_MOVIE_DATES;

describe("localDateIn", () => {
  it("gives the production's calendar date, not the server's", () => {
    // 20:00 UTC on the 10th is already the 11th in Manila (UTC+8).
    expect(localDateIn("Asia/Manila", "2026-09-10T20:00:00.000Z")).toBe("2026-09-11");
    expect(localDateIn("America/Los_Angeles", "2026-09-10T20:00:00.000Z")).toBe("2026-09-10");
  });
});

describe("interpretationContextFor", () => {
  it("shows the model names, scene numbers, and shoot days, and nothing else", () => {
    const context = interpretationContextFor(createDemoMovie(), "2026-09-10");
    expect(context.castMembers).toEqual([
      { id: cast.sarah, name: "Sarah", roleName: "Nadia" },
      { id: cast.john, name: "John", roleName: "Emil" },
      { id: cast.mike, name: "Mike", roleName: "Barista" },
    ]);
    expect(context.shootDays.map((day) => day.date)).toEqual([
      friday,
      DEMO_MOVIE_DATES.monday,
      DEMO_MOVIE_DATES.tuesday,
    ]);
    expect(context.today).toBe("2026-09-10");
    expect(JSON.stringify(context)).not.toMatch(/unavailable|tasks|callSheets|requirement/u);
  });
});

describe("interpretChange", () => {
  let store: MemoryStore;
  let interpret: InterpretChange;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.productions.save(createDemoMovie());
    interpret = createInterpretChange({
      repositories: store,
      model: createRuleModelAdapter(),
      clock: fixedClock("2026-09-10T03:00:00.000Z"),
      modelTimeoutMs: 200,
    });
  });

  it("turns a golden sentence into a typed change with resolved IDs", async () => {
    const result = await interpret({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      kind: "RESOLVED",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: cast.sarah,
        unavailable: { start: friday, end: friday },
      },
      confidence: 0.9,
    });
  });

  it.each([
    [
      "The warehouse is unavailable Friday.",
      { type: "LOCATION_UNAVAILABLE", locationId: locations.warehouse },
    ],
    [
      "Scene 18 now needs a red car.",
      {
        type: "SCENE_REQUIREMENT_CHANGED",
        sceneId: scenes.s18,
        requirement: { type: "PROP", name: "red car" },
      },
    ],
  ])("resolves %s", async (text, change) => {
    const result = await interpret({ productionId: DEMO, text });
    expect(result.ok && result.value).toMatchObject({ kind: "RESOLVED", change });
  });

  it("resolves 'today' against the production's timezone", async () => {
    // 22:00 UTC on the 17th is already Friday the 18th in Manila.
    const late = createInterpretChange({
      repositories: store,
      model: createRuleModelAdapter(),
      clock: fixedClock("2026-09-17T22:00:00.000Z"),
    });
    const result = await late({ productionId: DEMO, text: "Sarah is unavailable today." });
    expect(result.ok && result.value).toMatchObject({
      change: { unavailable: { start: friday, end: friday } },
    });
  });

  it("hands ambiguity back as a question with options", async () => {
    const state = createDemoMovie();
    await store.productions.save({
      ...state,
      castMembers: [
        ...state.castMembers,
        { id: "CAST-SARAH-2", productionId: DEMO, name: "Sarah", unavailable: [] },
      ],
    });
    const result = await interpret({ productionId: DEMO, text: "Sarah cannot shoot Friday." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("AMBIGUOUS");
    if (result.value.kind !== "AMBIGUOUS") return;
    expect(result.value.options).toHaveLength(2);
  });

  it("refuses an unsupported sentence with a reason and a hint", async () => {
    const result = await interpret({ productionId: DEMO, text: "Please make the film better." });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_CHANGE");
    expect(result.error.nextStep).toContain("unavailable");
  });

  it("refuses empty text and an unknown production", async () => {
    expect((await interpret({ productionId: DEMO, text: "   " })).ok).toBe(false);
    const missing = await interpret({
      productionId: "PROD-GHOST",
      text: "Sarah cannot shoot Friday.",
    });
    expect(!missing.ok && missing.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it.each([
    ["malformed", "MALFORMED_OUTPUT", "Rephrase"],
    ["hallucinate", "UNGROUNDED_OUTPUT", "Rephrase"],
    ["throw", "PROVIDER_ERROR", "Retry"],
    ["hang", "TIMEOUT", "Retry"],
  ] as const)(
    "never fabricates a change when the model misbehaves (%s)",
    async (misbehave, code, hint) => {
      const broken = createInterpretChange({
        repositories: store,
        model: createFakeModelAdapter({ misbehave }),
        clock: fixedClock(),
        modelTimeoutMs: 20,
      });
      const result = await broken({
        productionId: DEMO,
        text: "Sarah cannot shoot Friday.",
        correlationId: "corr-9",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "INTERNAL_ERROR",
        actual: code,
        correlationId: "corr-9",
      });
      expect(result.error.nextStep).toContain(hint);
    },
  );

  it("works with the fake adapter's canned answers too", async () => {
    const canned = createInterpretChange({
      repositories: store,
      model: createFakeModelAdapter(),
      clock: fixedClock(),
    });
    const result = await canned({ productionId: DEMO, text: "Scene 18 now needs a red car." });
    expect(result.ok && result.value).toMatchObject({
      kind: "RESOLVED",
      change: { sceneId: scenes.s18 },
    });
  });
});
