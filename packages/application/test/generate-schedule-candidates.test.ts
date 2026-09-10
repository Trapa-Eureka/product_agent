import { beforeEach, describe, expect, it } from "vitest";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";

import { createGenerateScheduleCandidates, type GenerateScheduleCandidates } from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { scenes, shootDays } = DEMO_MOVIE_IDS;

describe("generateScheduleCandidates", () => {
  let store: MemoryStore;
  let generate: GenerateScheduleCandidates;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.productions.save(createDemoMovie());
    generate = createGenerateScheduleCandidates({ repositories: store });
  });

  it("returns valid days with the version they were computed against", async () => {
    const result = await generate({ productionId: DEMO, sceneIds: [scenes.s07, scenes.s12] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productionVersion).toBe(1);
    expect(result.value.candidates.map((candidate) => candidate.shootDayId)).toEqual([
      shootDays.monday,
      shootDays.tuesday,
    ]);
    expect(result.value.rejected.map((day) => day.shootDayId)).toEqual([shootDays.friday]);
  });

  it("honours excluded dates", async () => {
    const result = await generate({
      productionId: DEMO,
      sceneIds: [scenes.s07],
      excludeDates: [DEMO_MOVIE_DATES.monday],
    });
    expect(result.ok && result.value.candidates.map((candidate) => candidate.date)).toEqual([
      DEMO_MOVIE_DATES.tuesday,
    ]);
  });

  it("writes nothing", async () => {
    await generate({ productionId: DEMO, sceneIds: [scenes.s07] });
    expect(await store.auditEvents.list(DEMO)).toEqual([]);
  });

  it("refuses an unknown scene, naming the lookup tool", async () => {
    const result = await generate({ productionId: DEMO, sceneIds: [scenes.s07, "S99"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "ENTITY_NOT_FOUND", actual: "S99" });
    expect(result.error.nextStep).toContain("get_scene");
  });

  it("refuses an unknown production", async () => {
    const result = await generate({ productionId: "PROD-GHOST", sceneIds: [scenes.s07] });
    expect(!result.ok && result.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it("refuses an empty scene list and a malformed date", async () => {
    const empty = await generate({ productionId: DEMO, sceneIds: [] });
    expect(!empty.ok && empty.error.code).toBe("INVALID_INPUT");

    const badDate = await generate({
      productionId: DEMO,
      sceneIds: [scenes.s07],
      excludeDates: ["next Monday"],
    });
    expect(!badDate.ok && badDate.error.code).toBe("INVALID_INPUT");
  });
});
