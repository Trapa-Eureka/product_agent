import type { ModelPort } from "@pca/application";
import type { InterpretedChange } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS } from "@pca/fixtures";

/**
 * Test-only model adapter (TESTING.md §5).
 *
 * Answers the three golden sentences with canned, correct interpretations,
 * and can be told to misbehave in each way a real provider might: return
 * something malformed, hallucinate an entity, throw, or hang. The guard is
 * what those tests are really testing.
 */

const { cast, locations, scenes } = DEMO_MOVIE_IDS;
const friday = { start: DEMO_MOVIE_DATES.friday, end: DEMO_MOVIE_DATES.friday };

export const GOLDEN_INTERPRETATIONS: Readonly<Record<string, InterpretedChange>> = {
  "Sarah cannot shoot Friday.": {
    kind: "RESOLVED",
    change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: friday },
    confidence: 0.95,
  },
  "The warehouse is unavailable Friday.": {
    kind: "RESOLVED",
    change: { type: "LOCATION_UNAVAILABLE", locationId: locations.warehouse, unavailable: friday },
    confidence: 0.95,
  },
  "Scene 18 now needs a red car.": {
    kind: "RESOLVED",
    change: {
      type: "SCENE_REQUIREMENT_CHANGED",
      sceneId: scenes.s18,
      requirement: { type: "PROP", name: "red car" },
    },
    confidence: 0.95,
  },
};

export type FakeMisbehaviour = "malformed" | "hallucinate" | "throw" | "hang";

export type FakeModelOptions = {
  readonly answers?: Readonly<Record<string, InterpretedChange>>;
  readonly misbehave?: FakeMisbehaviour;
};

export const createFakeModelAdapter = (options: FakeModelOptions = {}): ModelPort => {
  const answers = { ...GOLDEN_INTERPRETATIONS, ...options.answers };

  const misbehave = <T>(operation: string): Promise<T> | null => {
    switch (options.misbehave) {
      case "malformed":
        return Promise.resolve({
          kind: "RESOLVED",
          thoughts: "I think...",
          change: { type: "CAST_FIRED" },
        } as unknown as T);
      case "hallucinate":
        return Promise.resolve(
          (operation === "rankCandidates"
            ? { ranked: [{ shootDayId: "SD-2026-12-25", rank: 1, reason: "Christmas is free." }] }
            : {
                kind: "RESOLVED",
                change: { type: "CAST_UNAVAILABLE", castId: "CAST-SARA", unavailable: friday },
                confidence: 0.99,
              }) as unknown as T,
        );
      case "throw":
        return Promise.reject(new Error(`${operation}: provider returned 503`));
      case "hang":
        return new Promise<T>(() => undefined);
      default:
        return null;
    }
  };

  return {
    interpretChange: (input) =>
      misbehave<InterpretedChange>("interpretChange") ??
      Promise.resolve(
        answers[input.text.trim()] ?? {
          kind: "UNSUPPORTED",
          reason: `The fake model has no canned answer for "${input.text}".`,
        },
      ),
    explainImpact: (input) =>
      misbehave("explainImpact") ??
      Promise.resolve({
        explanation: `Fake explanation: ${input.impacts.length} impacts, ${input.conflicts.length} conflicts.`,
      }),
    rankCandidates: (input) =>
      misbehave("rankCandidates") ??
      Promise.resolve({
        ranked: input.candidates.map((candidate, index) => ({
          shootDayId: candidate.shootDayId,
          rank: index + 1,
          reason: "Fake ranking in the order given.",
        })),
      }),
  };
};
