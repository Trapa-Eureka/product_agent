import { describe, expect, it } from "vitest";

import { DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";
import { fixedClock, sequentialIds } from "@pca/test-support";

import type { LogFields, LogLevel, ModelPort } from "../src";
import { createRunChangeAgent, guardModelPort, isGuardedModelPort } from "../src";

/**
 * TASK-936 (code review #20): the guard is applied once, at the composition
 * root. One validation per provider call is what "once" means, so the test
 * counts both ends — what reached the provider, and how many `model_call`
 * lines the guard wrote — and expects them equal.
 */

/** Counts what actually reaches the provider, per operation. */
const counting = (inner: ModelPort): { port: ModelPort; calls: string[] } => {
  const calls: string[] = [];
  const port: ModelPort = {
    interpretChange: (input, options) => {
      calls.push("interpretChange");
      return inner.interpretChange(input, options);
    },
    explainImpact: (input, options) => {
      calls.push("explainImpact");
      return inner.explainImpact(input, options);
    },
    rankCandidates: (input, options) => {
      calls.push("rankCandidates");
      return inner.rankCandidates(input, options);
    },
  };
  return { port, calls };
};

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

describe("one model-guard boundary (TASK-936: code review #20)", () => {
  it("validates each model call exactly once between the agent and the provider", async () => {
    const logger = recordingLogger();
    const store = createMemoryStore();
    await store.productions.save(createDemoMovie());
    const { port, calls } = counting(createRuleModelAdapter());
    const run = createRunChangeAgent({
      repositories: store,
      model: guardModelPort(port, { logger }),
      clock: fixedClock("2026-09-10T03:00:00.000Z"),
      ids: sequentialIds(),
      logger,
    });

    const result = await run({
      productionId: DEMO_MOVIE_IDS.production,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "coordinator@example.test",
      correlationId: "corr-936",
    });

    expect(result.ok).toBe(true);
    const guarded = logger.lines.filter((line) => line.event === "model_call");
    expect(calls.length).toBeGreaterThan(0);
    expect(guarded.map((line) => line.fields["operation"])).toEqual(calls);
  });

  it("marks a guarded port and refuses to guard it again, naming where the guard belongs", () => {
    const raw = createRuleModelAdapter();
    expect(isGuardedModelPort(raw)).toBe(false);
    const guarded = guardModelPort(raw);
    expect(isGuardedModelPort(guarded)).toBe(true);
    expect(() => guardModelPort(guarded)).toThrow(/already guarded.*composition root/u);
  });
});
