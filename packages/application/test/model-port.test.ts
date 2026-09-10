import { describe, expect, it } from "vitest";

import type { InterpretChangeInput, RankCandidatesInput } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS } from "@pca/fixtures";

import type { LogFields, LogLevel } from "../src";
import { ModelError, guardModelPort, type ModelPort } from "../src";

/** Collects log lines instead of printing them, so a test can assert on shape. */
const recordingLogger = (): {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[];
  log: (level: LogLevel, event: string, fields?: LogFields) => void;
} => {
  const lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  return {
    lines,
    log: (level, event, fields = {}) => {
      lines.push({ level, event, fields });
    },
  };
};

/**
 * The guard is the whole safety story for the model layer: whatever provider
 * answers, these tests are what an adapter cannot get past.
 */

const { cast, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;

const interpretInput: InterpretChangeInput = {
  productionId: "PROD-DEMO",
  text: "Sarah cannot shoot Friday.",
  context: {
    castMembers: [
      { id: cast.sarah, name: "Sarah" },
      { id: cast.john, name: "John" },
    ],
    locations: [{ id: locations.warehouse, name: "Warehouse" }],
    scenes: [{ id: scenes.s07, sceneNumber: "07" }],
    shootDays: [
      { id: shootDays.friday, date: friday },
      { id: shootDays.monday, date: monday },
    ],
    today: "2026-09-10",
  },
};

const sarahOnFriday = {
  type: "CAST_UNAVAILABLE",
  castId: cast.sarah,
  unavailable: { start: friday, end: friday },
} as const;

const rankInput: RankCandidatesInput = {
  productionId: "PROD-DEMO",
  change: sarahOnFriday,
  candidates: [
    { shootDayId: shootDays.monday, date: monday, sceneIds: [scenes.s07], warnings: [] },
    { shootDayId: shootDays.tuesday, date: tuesday, sceneIds: [scenes.s07], warnings: [] },
  ],
};

/** A port whose answers the test dictates, however wrong. */
const stub = (answers: {
  interpret?: unknown;
  explain?: unknown;
  rank?: unknown;
  throws?: Error;
  delayMs?: number;
}): ModelPort => {
  const respond = <T>(value: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      setTimeout(
        () => (answers.throws ? reject(answers.throws) : resolve(value as T)),
        answers.delayMs ?? 0,
      );
    });
  return {
    interpretChange: () => respond(answers.interpret),
    explainImpact: () => respond(answers.explain),
    rankCandidates: () => respond(answers.rank),
  };
};

const failure = async (run: () => Promise<unknown>): Promise<ModelError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error("expected a ModelError");
};

describe("guardModelPort: interpretChange", () => {
  it("passes a well-formed, grounded interpretation through", async () => {
    const port = guardModelPort(
      stub({ interpret: { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 } }),
    );
    expect(await port.interpretChange(interpretInput)).toEqual({
      kind: "RESOLVED",
      change: sarahOnFriday,
      confidence: 0.9,
    });
  });

  it("passes an ambiguity with grounded options through", async () => {
    const options = [
      { label: "Sarah", change: sarahOnFriday },
      { label: "John", change: { ...sarahOnFriday, castId: cast.john } },
    ];
    const port = guardModelPort(
      stub({ interpret: { kind: "AMBIGUOUS", question: "Which one?", options } }),
    );
    expect((await port.interpretChange(interpretInput)).kind).toBe("AMBIGUOUS");
  });

  it.each([
    ["invalid JSON-ish text", "Sarah is out on Friday"],
    ["an unknown kind", { kind: "GUESSED", change: sarahOnFriday }],
    [
      "a wrong enum in the change",
      { kind: "RESOLVED", change: { ...sarahOnFriday, type: "CAST_FIRED" }, confidence: 0.9 },
    ],
    ["a confidence out of range", { kind: "RESOLVED", change: sarahOnFriday, confidence: 1.5 }],
    [
      "an extra field",
      { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9, thoughts: "hmm" },
    ],
    [
      "a single-option ambiguity",
      { kind: "AMBIGUOUS", question: "?", options: [{ label: "x", change: sarahOnFriday }] },
    ],
  ])("rejects %s as MALFORMED_OUTPUT", async (_label, interpret) => {
    const error = await failure(() =>
      guardModelPort(stub({ interpret })).interpretChange(interpretInput),
    );
    expect(error.code).toBe("MALFORMED_OUTPUT");
    expect(error.operation).toBe("interpretChange");
  });

  it("rejects a hallucinated entity ID as UNGROUNDED_OUTPUT, naming it", async () => {
    const error = await failure(() =>
      guardModelPort(
        stub({
          interpret: {
            kind: "RESOLVED",
            change: { ...sarahOnFriday, castId: "CAST-SARA" },
            confidence: 0.99,
          },
        }),
      ).interpretChange(interpretInput),
    );
    expect(error.code).toBe("UNGROUNDED_OUTPUT");
    expect(error.detail).toBe("CAST-SARA");
  });

  it("rejects an ambiguity whose options name an entity outside the context", async () => {
    const options = [
      { label: "Sarah", change: sarahOnFriday },
      { label: "Zoe", change: { ...sarahOnFriday, castId: "CAST-ZOE" } },
    ];
    const error = await failure(() =>
      guardModelPort(
        stub({ interpret: { kind: "AMBIGUOUS", question: "?", options } }),
      ).interpretChange(interpretInput),
    );
    expect(error.code).toBe("UNGROUNDED_OUTPUT");
  });

  it("grounds a schedule change against scenes and shoot days", async () => {
    const change = {
      type: "SCHEDULE_CHANGED",
      sceneIds: [scenes.s07],
      toShootDayId: "SD-2026-12-25",
    };
    const error = await failure(() =>
      guardModelPort(
        stub({ interpret: { kind: "RESOLVED", change, confidence: 0.8 } }),
      ).interpretChange(interpretInput),
    );
    expect(error.detail).toBe("SD-2026-12-25");
  });
});

describe("guardModelPort: explainImpact", () => {
  const input = {
    productionId: "PROD-DEMO",
    rawText: "Sarah cannot shoot Friday.",
    change: sarahOnFriday,
    impacts: [],
    conflicts: [],
  };

  it("passes a bounded explanation through", async () => {
    expect(
      await guardModelPort(
        stub({ explain: { explanation: "Two scenes move to Monday." } }),
      ).explainImpact(input),
    ).toEqual({ explanation: "Two scenes move to Monday." });
  });

  it.each([
    ["an empty explanation", { explanation: "" }],
    ["an over-long explanation", { explanation: "x".repeat(2001) }],
    ["a bare string", "Two scenes move."],
  ])("rejects %s", async (_label, explain) => {
    expect((await failure(() => guardModelPort(stub({ explain })).explainImpact(input))).code).toBe(
      "MALFORMED_OUTPUT",
    );
  });
});

describe("guardModelPort: rankCandidates", () => {
  it("passes a permutation with reasons through", async () => {
    const ranked = [
      { shootDayId: shootDays.tuesday, rank: 1, reason: "Nobody else is booked." },
      { shootDayId: shootDays.monday, rank: 2, reason: "John is already on set." },
    ];
    expect(await guardModelPort(stub({ rank: { ranked } })).rankCandidates(rankInput)).toEqual({
      ranked,
    });
  });

  it.each([
    [
      "a fabricated candidate",
      [
        { shootDayId: "SD-2026-12-25", rank: 1, reason: "r" },
        { shootDayId: shootDays.monday, rank: 2, reason: "r" },
      ],
    ],
    ["a dropped candidate", [{ shootDayId: shootDays.monday, rank: 1, reason: "r" }]],
    [
      "a duplicated candidate",
      [
        { shootDayId: shootDays.monday, rank: 1, reason: "r" },
        { shootDayId: shootDays.monday, rank: 2, reason: "r" },
      ],
    ],
  ])("rejects %s as UNGROUNDED_OUTPUT", async (_label, ranked) => {
    expect(
      (await failure(() => guardModelPort(stub({ rank: { ranked } })).rankCandidates(rankInput)))
        .code,
    ).toBe("UNGROUNDED_OUTPUT");
  });

  it("rejects ranks with a gap or a repeat as MALFORMED_OUTPUT", async () => {
    const ranked = [
      { shootDayId: shootDays.monday, rank: 1, reason: "r" },
      { shootDayId: shootDays.tuesday, rank: 3, reason: "r" },
    ];
    expect(
      (await failure(() => guardModelPort(stub({ rank: { ranked } })).rankCandidates(rankInput)))
        .code,
    ).toBe("MALFORMED_OUTPUT");
  });
});

describe("guardModelPort: provider faults", () => {
  it("wraps a provider exception as PROVIDER_ERROR without losing the cause", async () => {
    const error = await failure(() =>
      guardModelPort(stub({ throws: new Error("429 rate limited") })).interpretChange(
        interpretInput,
      ),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.detail).toBe("429 rate limited");
  });

  it("times out a provider that does not answer within the budget", async () => {
    const slow = stub({
      interpret: { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 },
      delayMs: 50,
    });
    const error = await failure(() =>
      guardModelPort(slow, { timeoutMs: 5 }).interpretChange(interpretInput),
    );
    expect(error.code).toBe("TIMEOUT");
  });

  it("does not time out a provider that answers in time", async () => {
    const quick = stub({
      interpret: { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 },
      delayMs: 1,
    });
    expect(
      (await guardModelPort(quick, { timeoutMs: 500 }).interpretChange(interpretInput)).kind,
    ).toBe("RESOLVED");
  });
});

describe("guardModelPort: timing (TASK-804)", () => {
  it("logs one model_call line per successful call, with a numeric duration", async () => {
    const logger = recordingLogger();
    const port = guardModelPort(
      stub({ interpret: { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 } }),
      { logger },
    );

    await port.interpretChange(interpretInput);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", event: "model_call" });
    expect(logger.lines[0]?.fields["operation"]).toBe("interpretChange");
    expect(logger.lines[0]?.fields["outcome"]).toBe("ok");
    expect(typeof logger.lines[0]?.fields["durationMs"]).toBe("number");
  });

  it("logs outcome: error for a provider fault, and still throws", async () => {
    const logger = recordingLogger();
    const port = guardModelPort(stub({ throws: new Error("429 rate limited") }), { logger });

    await expect(port.interpretChange(interpretInput)).rejects.toThrow(ModelError);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.fields["operation"]).toBe("interpretChange");
    expect(logger.lines[0]?.fields["outcome"]).toBe("error");
  });

  it("logs outcome: error for a timeout", async () => {
    const logger = recordingLogger();
    const slow = stub({
      interpret: { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 },
      delayMs: 50,
    });

    await expect(
      guardModelPort(slow, { timeoutMs: 5, logger }).interpretChange(interpretInput),
    ).rejects.toThrow(ModelError);

    expect(logger.lines[0]?.fields["outcome"]).toBe("error");
  });

  it("stays silent without a logger, the default every test above already relies on", async () => {
    const port = guardModelPort(
      stub({ interpret: { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 } }),
    );
    expect((await port.interpretChange(interpretInput)).kind).toBe("RESOLVED");
  });
});
