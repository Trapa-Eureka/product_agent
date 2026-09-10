import { beforeEach, describe, expect, it } from "vitest";

import type { AgentJobEvent } from "@pca/contracts";
import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { fixedClock, sequentialIds } from "@pca/test-support";

import { JobStageError, UnknownJobError, createJobTracker, type JobTracker } from "../src";

const NOW = "2026-09-10T12:00:00.000Z";

describe("jobTracker", () => {
  let tracker: JobTracker;
  let published: AgentJobEvent[];

  beforeEach(() => {
    tracker = createJobTracker({
      repository: createMemoryJobRunRepository(),
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });
    published = [];
    tracker.onEvent((event) => published.push(event));
  });

  it("starts a run, persists it, and publishes received STARTED", async () => {
    const run = await tracker.start({
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
    });
    expect(run.id).toBe("JOB-1");
    expect(await tracker.get("JOB-1")).toEqual(run);
    expect(published).toEqual([
      expect.objectContaining({ jobId: "JOB-1", stage: "received", status: "STARTED" }),
    ]);
  });

  it("advances, fails, and notes through the stage machine, publishing what it records", async () => {
    await tracker.start({
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
    });
    await tracker.advance("JOB-1", "resolving");
    await tracker.note("JOB-1", "Which Sarah?");
    const failed = await tracker.fail("JOB-1", "gave up");
    expect(failed.stage).toBe("failed");
    expect(published.map((event) => `${event.stage}:${event.status}`)).toEqual([
      "received:STARTED",
      "received:COMPLETED",
      "resolving:STARTED",
      "resolving:STARTED",
      "resolving:FAILED",
    ]);
    expect((await tracker.get("JOB-1"))?.history).toEqual(published);
  });

  it("refuses a disallowed move and leaves the record untouched", async () => {
    await tracker.start({
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
    });
    await expect(tracker.advance("JOB-1", "applying")).rejects.toThrow(JobStageError);
    expect((await tracker.get("JOB-1"))?.stage).toBe("received");
    expect(published).toHaveLength(1);
  });

  it("names a job it does not know", async () => {
    await expect(tracker.advance("JOB-9", "resolving")).rejects.toThrow(UnknownJobError);
    expect(await tracker.get("JOB-9")).toBeNull();
  });

  it("lists a production's runs newest first and stops publishing when unsubscribed", async () => {
    const clock = fixedClock(NOW);
    tracker = createJobTracker({
      repository: createMemoryJobRunRepository(),
      clock,
      ids: sequentialIds(),
    });
    const seen: string[] = [];
    const unsubscribe = tracker.onEvent((event) => seen.push(event.jobId));
    await tracker.start({
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
    });
    clock.advance(1000);
    await tracker.start({
      productionId: "PROD-DEMO",
      correlationId: "corr-2",
      type: "ANALYZE_CHANGE",
    });
    await tracker.start({
      productionId: "PROD-OTHER",
      correlationId: "corr-3",
      type: "ANALYZE_CHANGE",
    });
    unsubscribe();
    await tracker.advance("JOB-1", "resolving");
    expect((await tracker.listByProduction("PROD-DEMO")).map((run) => run.id)).toEqual([
      "JOB-2",
      "JOB-1",
    ]);
    expect(seen).toEqual(["JOB-1", "JOB-2", "JOB-3"]);
  });
});
