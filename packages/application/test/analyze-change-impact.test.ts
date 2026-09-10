import { beforeEach, describe, expect, it } from "vitest";

import type { TypedChange } from "@pca/contracts";
import { impactExplanationSchema } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";

import { createAnalyzeChangeImpact, type AnalyzeChangeImpact } from "../src";

const DEMO = DEMO_MOVIE_IDS.production;

const sarahOnFriday: TypedChange = {
  type: "CAST_UNAVAILABLE",
  castId: DEMO_MOVIE_IDS.cast.sarah,
  unavailable: { start: DEMO_MOVIE_DATES.friday, end: DEMO_MOVIE_DATES.friday },
};

describe("analyzeChangeImpact", () => {
  let store: MemoryStore;
  let analyze: AnalyzeChangeImpact;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.productions.save(createDemoMovie());
    analyze = createAnalyzeChangeImpact({ repositories: store });
  });

  it("returns the engine's findings with the version they were computed against", async () => {
    const result = await analyze({ productionId: DEMO, change: sarahOnFriday });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productionVersion).toBe(1);
    expect(result.value.affectedEntityIds).toContain(DEMO_MOVIE_IDS.scenes.s07);
    expect(result.value.conflicts).toHaveLength(2);
  });

  it("GOLDEN-1: also returns the DESIGN.md §3 impact panel, grouped and named by Sarah", async () => {
    const result = await analyze({ productionId: DEMO, change: sarahOnFriday });
    if (!result.ok) throw new Error(result.error.message);

    expect(impactExplanationSchema.parse(result.value.explanation)).toEqual(
      result.value.explanation,
    );
    expect(result.value.explanation.blocking).toEqual([
      "2 scheduled scenes conflict with Sarah's availability.",
    ]);
    expect(result.value.explanation.affected.scenes).toEqual(["07", "12"]);
    expect(result.value.explanation.affected.shootDays).toEqual(["Fri Sep 18"]);
    expect(result.value.explanation.affected.callSheets).toEqual(["Call sheet Fri Sep 18"]);
    expect(result.value.explanation.why[0]).toContain("Scene 07");
  });

  it("reflects the current version after the production changes", async () => {
    await store.productions.commit({ productionId: DEMO, expectedVersion: 1 });
    const result = await analyze({ productionId: DEMO, change: sarahOnFriday });
    expect(result.ok && result.value.productionVersion).toBe(2);
  });

  it("writes nothing: analysis is a read", async () => {
    await analyze({ productionId: DEMO, change: sarahOnFriday });
    expect(await store.auditEvents.list(DEMO)).toEqual([]);
    expect((await store.productions.loadState(DEMO))?.production.version).toBe(1);
  });

  it("refuses an unknown production", async () => {
    const result = await analyze({ productionId: "PROD-GHOST", change: sarahOnFriday });
    expect(!result.ok && result.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it("refuses an unknown entity with the same message intake gives", async () => {
    const result = await analyze({
      productionId: DEMO,
      change: { ...sarahOnFriday, castId: "CAST-GHOST" },
      correlationId: "corr-9",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      actual: "CAST-GHOST",
      correlationId: "corr-9",
    });
    expect(result.error.nextStep).toContain("find_cast");
  });

  it("refuses a malformed change", async () => {
    const result = await analyze({
      productionId: DEMO,
      change: { type: "CAST_UNAVAILABLE" } as unknown as TypedChange,
    });
    expect(!result.ok && result.error.code).toBe("INVALID_INPUT");
  });
});
