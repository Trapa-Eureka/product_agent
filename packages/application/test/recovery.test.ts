import { describe, expect, it } from "vitest";

import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { fixedClock, sequentialIds } from "@pca/test-support";

import { INTERRUPTED_REASON, createJobTracker, reconcileInterruptedRuns } from "../src";

/** TASK-923: the startup pass over unfinished runs, against the memory store. */
describe("reconcileInterruptedRuns", () => {
  it("fails worker-owned stages, keeps human-owned ones, and logs what it did", async () => {
    const repository = createMemoryJobRunRepository();
    const tracker = createJobTracker({
      repository,
      clock: fixedClock("2026-09-10T12:00:00.000Z"),
      ids: sequentialIds(),
    });
    const start = () =>
      tracker.start({ productionId: "PROD-DEMO", correlationId: "corr-1", type: "ANALYZE_CHANGE" });
    const received = await start();
    const simulating = await start();
    for (const stage of ["analyzing", "simulating"] as const)
      await tracker.advance(simulating.id, stage);
    const awaiting = await start();
    for (const stage of ["analyzing", "simulating", "validating", "awaiting_approval"] as const) {
      await tracker.advance(awaiting.id, stage);
    }
    const events: string[] = [];
    const logger = { log: (_level: string, event: string) => events.push(event) };

    const outcome = await reconcileInterruptedRuns({ tracker, repository, logger });
    expect(outcome.failed.map((run) => run.id)).toEqual([received.id, simulating.id]);
    expect(outcome.kept.map((run) => run.id)).toEqual([awaiting.id]);
    expect((await repository.findById(received.id))?.message).toBe(INTERRUPTED_REASON);
    expect((await repository.findById(simulating.id))?.status).toBe("FAILED");
    expect(events.filter((event) => event === "job_interrupted_by_restart")).toHaveLength(2);
    expect(events).toContain("job_runs_reconciled");
  });

  it("is quiet when there is nothing unfinished", async () => {
    const repository = createMemoryJobRunRepository();
    const tracker = createJobTracker({
      repository,
      clock: fixedClock("2026-09-10T12:00:00.000Z"),
      ids: sequentialIds(),
    });
    const events: string[] = [];
    expect(
      await reconcileInterruptedRuns({
        tracker,
        repository,
        logger: { log: (_level: string, event: string) => events.push(event) },
      }),
    ).toEqual({ failed: [], kept: [] });
    expect(events).toEqual([]);
  });
});
