import { describe, expect, it } from "vitest";

import type { InterpretChangeInput, RankCandidatesInput } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createFakeModelAdapter } from "@pca/test-support";

import { ModelError, guardModelPort } from "../src";

/** TESTING.md §5: every way a provider can misbehave is caught by the guard. */

const demo = createDemoMovie();
const input: InterpretChangeInput = {
  productionId: "PROD-DEMO",
  text: "Sarah cannot shoot Friday.",
  context: {
    castMembers: demo.castMembers.map((member) => ({ id: member.id, name: member.name })),
    locations: demo.locations.map((location) => ({ id: location.id, name: location.name })),
    scenes: demo.scenes.map((scene) => ({ id: scene.id, sceneNumber: scene.sceneNumber })),
    shootDays: demo.shootDays.map((day) => ({ id: day.id, date: day.date })),
    today: "2026-09-10",
  },
};

const rankInput: RankCandidatesInput = {
  productionId: "PROD-DEMO",
  change: {
    type: "CAST_UNAVAILABLE",
    castId: DEMO_MOVIE_IDS.cast.sarah,
    unavailable: { start: DEMO_MOVIE_DATES.friday, end: DEMO_MOVIE_DATES.friday },
  },
  candidates: [
    {
      shootDayId: DEMO_MOVIE_IDS.shootDays.monday,
      date: DEMO_MOVIE_DATES.monday,
      sceneIds: [DEMO_MOVIE_IDS.scenes.s07],
      warnings: [],
    },
  ],
};

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "none";
  } catch (error) {
    return error instanceof ModelError ? error.code : "not-a-model-error";
  }
};

describe("fake model adapter", () => {
  it("answers the golden sentences correctly and passes the guard", async () => {
    const port = guardModelPort(createFakeModelAdapter());
    expect((await port.interpretChange(input)).kind).toBe("RESOLVED");
    expect(
      (await port.interpretChange({ ...input, text: "Scene 18 now needs a red car." })).kind,
    ).toBe("RESOLVED");
    expect((await port.interpretChange({ ...input, text: "Make it rain." })).kind).toBe(
      "UNSUPPORTED",
    );
  });

  it.each([
    ["malformed", "MALFORMED_OUTPUT"],
    ["hallucinate", "UNGROUNDED_OUTPUT"],
    ["throw", "PROVIDER_ERROR"],
    ["hang", "TIMEOUT"],
  ] as const)(
    "a provider that misbehaves (%s) is caught by the guard as %s",
    async (misbehave, code) => {
      const port = guardModelPort(createFakeModelAdapter({ misbehave }), { timeoutMs: 20 });
      expect(await codeOf(() => port.interpretChange(input))).toBe(code);
    },
  );

  it("a hallucinated candidate day is caught in ranking too", async () => {
    const port = guardModelPort(createFakeModelAdapter({ misbehave: "hallucinate" }));
    expect(await codeOf(() => port.rankCandidates(rankInput))).toBe("UNGROUNDED_OUTPUT");
  });
});
