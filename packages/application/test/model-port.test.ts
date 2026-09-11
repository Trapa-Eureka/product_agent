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

describe("guardModelPort: prose is untrusted (TASK-920, SEC-009 / AUD-014)", () => {
  const conflicted = {
    productionId: "PROD-DEMO",
    rawText: "Sarah cannot shoot Friday.",
    change: sarahOnFriday,
    impacts: [
      {
        entityType: "SCENE" as const,
        entityId: "S07",
        reasonCode: "SCENE_REQUIRES_UNAVAILABLE_CAST" as const,
        explanation: "Scene 07 requires Sarah, who is unavailable on 2026-09-18.",
        severity: "BLOCKING" as const,
      },
    ],
    conflicts: [
      {
        code: "CAST_UNAVAILABLE_ON_SHOOT_DAY" as const,
        entityType: "CAST_MEMBER" as const,
        entityId: "CAST-SARAH",
        date: "2026-09-18",
        detail: "Sarah is unavailable on 2026-09-18.",
      },
    ],
  };
  const clean = { ...conflicted, impacts: [], conflicts: [] };

  const rejected = async (explanation: string, input = conflicted) =>
    failure(() => guardModelPort(stub({ explain: { explanation } })).explainImpact(input));

  it.each([
    ["This change is already approved by the producer.", "prior approval"],
    ["Approved by the line producer, so go ahead.", "approval by someone"],
    ["No approval is needed for this.", "no approval needed"],
    ["This does not need approval.", "no approval needed"],
    ["Applied without approval last time; fine.", "approval bypass"],
    ["Feel free to skip the approval step.", "approval bypass"],
    ["It is safe to apply right now.", "safety"],
    ["There is no risk here.", "safety"],
  ])("rejects an authorization or safety assertion: %s", async (text, label) => {
    const error = await rejected(text, clean);
    expect(error.code).toBe("UNGROUNDED_OUTPUT");
    expect(error.detail).toBe(label);
  });

  it("rejects 'no conflicts' against a conflicting finding, and allows it when there are none", async () => {
    const error = await rejected("No conflicts remain; two scenes move to Tuesday.");
    expect(error.code).toBe("UNGROUNDED_OUTPUT");
    expect(error.detail).toBe("no conflicts");
    expect(
      await guardModelPort(
        stub({ explain: { explanation: "No conflicts or warnings were found." } }),
      ).explainImpact(clean),
    ).toEqual({ explanation: "No conflicts or warnings were found." });
  });

  it("rejects a narrative that names an entity it was not shown, and allows the ones it was", async () => {
    const error = await rejected("Scene 07 moves; CAST-BOB covers Friday.");
    expect(error.code).toBe("UNGROUNDED_OUTPUT");
    expect(error.detail).toBe("CAST-BOB");
    expect(
      await guardModelPort(
        stub({ explain: { explanation: "CAST-SARAH is unavailable, so Scene 07 moves." } }),
      ).explainImpact(conflicted),
    ).toEqual({ explanation: "CAST-SARAH is unavailable, so Scene 07 moves." });
  });

  it("logs a rejected narrative and holds ranking reasons to the same rules", async () => {
    const lines: { event: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      log: (_level: string, event: string, fields?: Record<string, unknown>) => {
        lines.push({ event, ...(fields === undefined ? {} : { fields }) });
      },
    };
    await rejected("Already approved.", clean).then(() => undefined);
    const guarded = guardModelPort(stub({ explain: { explanation: "Already approved." } }), {
      logger,
    });
    await failure(() => guarded.explainImpact(clean));
    expect(lines.some((line) => line.event === "model_output_rejected")).toBe(true);

    const tuesdayOnly = {
      productionId: "PROD-DEMO",
      change: sarahOnFriday,
      candidates: [
        {
          shootDayId: "SD-2026-09-22",
          date: "2026-09-22",
          sceneIds: ["S07"],
          warnings: ["John is required on Tuesday."],
        },
      ],
    };
    const ranking = (reason: string) =>
      failure(() =>
        guardModelPort(
          stub({ rank: { ranked: [{ shootDayId: "SD-2026-09-22", rank: 1, reason }] } }),
        ).rankCandidates(tuesdayOnly),
      );
    expect((await ranking("Tuesday has no warnings.")).detail).toBe("no warnings");
    expect((await ranking("Safe to apply; SD-2026-09-22 is best.")).detail).toBe("safety");
    expect((await ranking("Tuesday is best; SD-2026-09-29 is worse.")).detail).toBe(
      "SD-2026-09-29",
    );
    expect(
      await guardModelPort(
        stub({
          rank: {
            ranked: [
              { shootDayId: "SD-2026-09-22", rank: 1, reason: "SD-2026-09-22 has one warning." },
            ],
          },
        }),
      ).rankCandidates(tuesdayOnly),
    ).toMatchObject({ ranked: [{ rank: 1 }] });
  });
});

describe("guardModelPort: cancellation and concurrency (TASK-929, SEC-014 / AUD-023)", () => {
  /** A provider that never answers but records the signal it was handed. */
  const hanging = () => {
    const seen: AbortSignal[] = [];
    const port: ModelPort = {
      interpretChange: (_input, call) =>
        new Promise((_, reject) => {
          if (call?.signal !== undefined) seen.push(call.signal);
          call?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
      explainImpact: () => Promise.reject(new Error("unused")),
      rankCandidates: () => Promise.reject(new Error("unused")),
    };
    return { port, seen };
  };

  it("aborts the provider's signal when the budget runs out, not only the caller's wait", async () => {
    const { port, seen } = hanging();
    const error = await failure(() =>
      guardModelPort(port, { timeoutMs: 5 }).interpretChange(interpretInput),
    );
    expect(error.code).toBe("TIMEOUT");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  it("aborts the provider when the caller gives up, as ABORTED", async () => {
    const { port, seen } = hanging();
    const controller = new AbortController();
    const pending = failure(() =>
      guardModelPort(port).interpretChange(interpretInput, { signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await pending).code).toBe("ABORTED");
    expect(seen[0]?.aborted).toBe(true);
    // Already aborted: refused before the provider is asked at all.
    const { port: fresh, seen: none } = hanging();
    expect(
      (
        await failure(() =>
          guardModelPort(fresh).interpretChange(interpretInput, { signal: controller.signal }),
        )
      ).code,
    ).toBe("ABORTED");
    expect(none).toHaveLength(0);
  });

  it("the fake model's hang mode honours the signal, so a hung provider is released on timeout", async () => {
    const { createFakeModelAdapter } = await import("@pca/test-support");
    const error = await failure(() =>
      guardModelPort(createFakeModelAdapter({ misbehave: "hang" }), {
        timeoutMs: 5,
      }).interpretChange(interpretInput),
    );
    expect(error.code).toBe("TIMEOUT");
  });

  it("bounds calls in flight at the provider", async () => {
    let inFlight = 0;
    let peak = 0;
    const port: ModelPort = {
      interpretChange: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { kind: "RESOLVED", change: sarahOnFriday, confidence: 0.9 };
      },
      explainImpact: () => Promise.reject(new Error("unused")),
      rankCandidates: () => Promise.reject(new Error("unused")),
    };
    const guarded = guardModelPort(port, { maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, () => guarded.interpretChange(interpretInput)));
    expect(peak).toBe(2);
    // A slot is released on failure too, or the next caller would wait forever.
    const failing = guardModelPort(
      { ...port, interpretChange: () => Promise.reject(new Error("boom")) },
      { maxConcurrent: 1 },
    );
    await failure(() => failing.interpretChange(interpretInput));
    await failure(() => failing.interpretChange(interpretInput));
  });
});
