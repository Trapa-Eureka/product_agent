import { describe, expect, it } from "vitest";

import type { EnqueueJobInput, JobHandlerOutcome } from "@pca/application";
import {
  describeQueueContract,
  fixedClock,
  manualScheduler,
  sequentialIds,
} from "@pca/test-support";

import { createMemoryQueue } from "../src";

describeQueueContract("memory queue", (policy) =>
  createMemoryQueue({
    policy,
    clock: fixedClock("2026-09-10T12:00:00.000Z"),
    ids: sequentialIds(),
  }),
);

const job = (overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput => ({
  type: "ANALYZE_CHANGE",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  idempotencyKey: "idem-key-0001",
  payload: {},
  ...overrides,
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("memory queue specifics", () => {
  it("stamps records and transitions from the injected clock and ids", async () => {
    const queue = createMemoryQueue({
      clock: fixedClock("2026-09-10T12:00:00.000Z"),
      ids: sequentialIds(),
    });
    const { record } = await queue.enqueue(job());
    expect(record.job.id).toBe("JOB-1");
    expect(record.enqueuedAt).toBe("2026-09-10T12:00:00.000Z");
  });

  it("started: delivers through the scheduler as jobs arrive", async () => {
    const scheduler = manualScheduler();
    const queue = createMemoryQueue({ scheduler });
    const calls: number[] = [];
    queue.register("ANALYZE_CHANGE", (envelope) => {
      calls.push(envelope.attempt);
      return Promise.resolve({ kind: "COMPLETED" });
    });
    queue.start();
    const { record } = await queue.enqueue(job());
    expect(calls).toEqual([]);
    expect(scheduler.delays).toEqual([0]);

    scheduler.runNext();
    await settle();
    expect(calls).toEqual([1]);
    expect((await queue.getJob(record.job.id))?.state).toBe("COMPLETED");
  });

  it("started: waits the policy's backoff before each retry", async () => {
    const scheduler = manualScheduler();
    const outcomes: JobHandlerOutcome[] = [
      { kind: "RETRY", reason: "busy" },
      { kind: "RETRY", reason: "busy" },
      { kind: "COMPLETED" },
    ];
    const queue = createMemoryQueue({
      scheduler,
      policy: { maxAttempts: 3, retryDelayMs: (attempt) => attempt * 100 },
    });
    queue.register("ANALYZE_CHANGE", () =>
      Promise.resolve(outcomes.shift() ?? { kind: "COMPLETED" }),
    );
    queue.start();
    const { record } = await queue.enqueue(job());

    scheduler.runNext(); // initial delivery
    await settle();
    expect(await queue.getJob(record.job.id)).toMatchObject({
      state: "QUEUED",
      job: { attempt: 2 },
    });
    expect(scheduler.delays).toEqual([0, 200]);

    scheduler.runNext(); // retry 2
    await settle();
    expect(scheduler.delays).toEqual([0, 200, 300]);

    scheduler.runNext(); // retry 3
    await settle();
    expect(await queue.getJob(record.job.id)).toMatchObject({
      state: "COMPLETED",
      job: { attempt: 3 },
    });
    expect(scheduler.pending()).toBe(0);
  });

  it("drain runs waiting retries now instead of waiting for their timers", async () => {
    const scheduler = manualScheduler();
    let first = true;
    const queue = createMemoryQueue({ scheduler });
    queue.register("ANALYZE_CHANGE", () => {
      if (first) {
        first = false;
        return Promise.resolve({ kind: "RETRY", reason: "busy" });
      }
      return Promise.resolve({ kind: "COMPLETED" });
    });
    queue.start();
    const { record } = await queue.enqueue(job());
    scheduler.runNext();
    await settle();
    expect(scheduler.pending()).toBe(1);

    expect(await queue.drain()).toBe(1);
    expect((await queue.getJob(record.job.id))?.state).toBe("COMPLETED");
    expect(scheduler.pending()).toBe(0);
  });

  it("stop cancels pending timers; the retry runs at the next drain", async () => {
    const scheduler = manualScheduler();
    let first = true;
    const queue = createMemoryQueue({ scheduler });
    queue.register("ANALYZE_CHANGE", () => {
      if (first) {
        first = false;
        return Promise.resolve({ kind: "RETRY", reason: "busy" });
      }
      return Promise.resolve({ kind: "COMPLETED" });
    });
    queue.start();
    const { record } = await queue.enqueue(job());
    scheduler.runNext();
    await settle();
    queue.stop();
    expect(scheduler.pending()).toBe(0);
    expect((await queue.getJob(record.job.id))?.state).toBe("QUEUED");

    await queue.drain();
    expect((await queue.getJob(record.job.id))?.state).toBe("COMPLETED");
  });

  it("a duplicate delivery of a finished job never runs the handler again", async () => {
    const queue = createMemoryQueue();
    let calls = 0;
    queue.register("ANALYZE_CHANGE", () => {
      calls += 1;
      return Promise.resolve({ kind: "COMPLETED" });
    });
    const transitions: string[] = [];
    queue.onTransition((transition) => transitions.push(transition.to));
    const { record } = await queue.enqueue(job());
    await queue.drain();

    queue.redeliver(record.job.id);
    expect(await queue.drain()).toBe(0);
    expect(calls).toBe(1);
    expect(transitions).toEqual(["QUEUED", "RUNNING", "COMPLETED"]);
  });

  it("lists every job it has seen", async () => {
    const queue = createMemoryQueue({ ids: sequentialIds() });
    await queue.enqueue(job({ idempotencyKey: "idem-key-a" }));
    await queue.enqueue(job({ idempotencyKey: "idem-key-b" }));
    expect((await queue.listJobs()).map((entry) => entry.job.id)).toEqual(["JOB-1", "JOB-2"]);
  });

  it("hands out copies, so a caller cannot edit a record in place", async () => {
    const queue = createMemoryQueue();
    const { record } = await queue.enqueue(job());
    (record.job as { attempt: number }).attempt = 99;
    expect((await queue.getJob(record.job.id))?.job.attempt).toBe(1);
  });
});
