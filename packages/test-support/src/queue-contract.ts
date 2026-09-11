import { beforeEach, describe, expect, it } from "vitest";

import type { EnqueueJobInput, JobHandlerOutcome, QueuePolicy, QueuePort } from "@pca/application";

/**
 * Queue contract suite (TESTING.md §6, TASK-401).
 *
 * Every queue adapter, the in-process one today and SQS if a budget ever
 * exists, runs this suite. It pins the behaviour the application relies on:
 * enqueue, idempotent duplicates, bounded retry, terminal failure, and the
 * state transitions the job state machine and the WebSocket gateway consume.
 */

export type QueueFactory = (policy: QueuePolicy) => Promise<QueuePort> | QueuePort;

const POLICY: QueuePolicy = { maxAttempts: 3, retryDelayMs: () => 0 };

const job = (overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput => ({
  type: "ANALYZE_CHANGE",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  idempotencyKey: "idem-key-0001",
  payload: { changeRequestId: "CR-1" },
  ...overrides,
});

/** A handler that answers from a script, then completes. */
const scripted = (outcomes: JobHandlerOutcome[]) => {
  const calls: number[] = [];
  const handler = (envelope: { attempt: number }): Promise<JobHandlerOutcome> => {
    calls.push(envelope.attempt);
    return Promise.resolve(outcomes.shift() ?? { kind: "COMPLETED" });
  };
  return { handler, calls };
};

export const describeQueueContract = (name: string, create: QueueFactory): void => {
  describe(`queue contract: ${name}`, () => {
    let queue: QueuePort;
    let transitions: string[];

    beforeEach(async () => {
      queue = await create(POLICY);
      transitions = [];
      queue.onTransition((transition) => {
        transitions.push(
          `${transition.from ?? "-"}>${transition.to}@${transition.attempt}${
            transition.reason === undefined ? "" : `:${transition.reason}`
          }`,
        );
      });
    });

    describe("enqueue", () => {
      it("accepts a job as attempt 1 in the QUEUED state and can find it again", async () => {
        const outcome = await queue.enqueue(job());
        expect(outcome.kind).toBe("ENQUEUED");
        expect(outcome.record).toMatchObject({
          state: "QUEUED",
          deadLettered: false,
          job: { type: "ANALYZE_CHANGE", productionId: "PROD-DEMO", attempt: 1 },
        });
        expect(await queue.getJob(outcome.record.job.id)).toEqual(outcome.record);
        expect(transitions).toEqual(["->QUEUED@1"]);
      });

      it("returns null for a job it never saw", async () => {
        expect(await queue.getJob("JOB-nope")).toBeNull();
      });

      it("refuses a malformed job before it can reach a handler", async () => {
        await expect(
          queue.enqueue({ ...job(), type: "DELETE_EVERYTHING" as "ANALYZE_CHANGE" }),
        ).rejects.toThrow(/type/);
      });
    });

    describe("duplicate message / idempotency", () => {
      it("answers DUPLICATE for a second enqueue with the same idempotency key and runs the handler once", async () => {
        const { handler, calls } = scripted([]);
        queue.register("ANALYZE_CHANGE", handler);
        const first = await queue.enqueue(job());
        const second = await queue.enqueue(job({ correlationId: "corr-2" }));
        expect(second.kind).toBe("DUPLICATE");
        expect(second.record.job.id).toBe(first.record.job.id);
        expect(second.record.job.correlationId).toBe("corr-1");

        expect(await queue.drain()).toBe(1);
        expect(calls).toEqual([1]);
      });

      it("keeps different keys apart", async () => {
        const first = await queue.enqueue(job());
        const second = await queue.enqueue(job({ idempotencyKey: "idem-key-0002" }));
        expect(second.kind).toBe("ENQUEUED");
        expect(second.record.job.id).not.toBe(first.record.job.id);
      });

      it("scopes identity by production, so one production's key cannot suppress another's job (TASK-935)", async () => {
        const first = await queue.enqueue(job({ productionId: "PROD-A" }));
        const second = await queue.enqueue(job({ productionId: "PROD-B" }));
        expect(second.kind).toBe("ENQUEUED");
        expect(second.record.job.id).not.toBe(first.record.job.id);
        expect((await queue.enqueue(job({ productionId: "PROD-B" }))).kind).toBe("DUPLICATE");
      });

      it("scopes identity by job type, so an analyze and an apply may share a key (TASK-935)", async () => {
        const first = await queue.enqueue(job({ type: "ANALYZE_CHANGE" }));
        const second = await queue.enqueue(job({ type: "APPLY_PROPOSAL" }));
        expect(second.kind).toBe("ENQUEUED");
        expect(second.record.job.id).not.toBe(first.record.job.id);
        expect((await queue.enqueue(job({ type: "APPLY_PROPOSAL" }))).kind).toBe("DUPLICATE");
      });

      it("cannot be tricked into a collision by separators inside the parts (TASK-935)", async () => {
        // A naive `${productionId}::${type}::${key}` join would read both as
        // "PROD-A::ANALYZE_CHANGE::forge::ANALYZE_CHANGE::idem-key-0009".
        const first = await queue.enqueue(
          job({ productionId: "PROD-A", idempotencyKey: "forge::ANALYZE_CHANGE::idem-key-0009" }),
        );
        const second = await queue.enqueue(
          job({ productionId: "PROD-A::ANALYZE_CHANGE::forge", idempotencyKey: "idem-key-0009" }),
        );
        expect(second.kind).toBe("ENQUEUED");
        expect(second.record.job.id).not.toBe(first.record.job.id);
      });
    });

    describe("delivery", () => {
      it("completes a job whose handler completes, with QUEUED → RUNNING → COMPLETED", async () => {
        const { handler } = scripted([{ kind: "COMPLETED" }]);
        queue.register("ANALYZE_CHANGE", handler);
        const { record } = await queue.enqueue(job());
        expect(await queue.drain()).toBe(1);
        expect(await queue.getJob(record.job.id)).toMatchObject({
          state: "COMPLETED",
          deadLettered: false,
        });
        expect(transitions).toEqual(["->QUEUED@1", "QUEUED>RUNNING@1", "RUNNING>COMPLETED@1"]);
      });

      it("delivers jobs in enqueue order, one at a time", async () => {
        const order: string[] = [];
        queue.register("ANALYZE_CHANGE", (envelope) => {
          order.push(envelope.idempotencyKey);
          return Promise.resolve({ kind: "COMPLETED" });
        });
        await queue.enqueue(job({ idempotencyKey: "idem-key-a" }));
        await queue.enqueue(job({ idempotencyKey: "idem-key-b" }));
        await queue.enqueue(job({ idempotencyKey: "idem-key-c" }));
        await queue.drain();
        expect(order).toEqual(["idem-key-a", "idem-key-b", "idem-key-c"]);
      });

      it("hands the handler the envelope with the current attempt and the payload", async () => {
        let seen: unknown;
        queue.register("APPLY_PROPOSAL", (envelope) => {
          seen = envelope;
          return Promise.resolve({ kind: "COMPLETED" });
        });
        const { record } = await queue.enqueue(
          job({ type: "APPLY_PROPOSAL", payload: { proposalId: "P-1" } }),
        );
        await queue.drain();
        expect(seen).toEqual({ ...record.job, attempt: 1 });
      });

      it("fails a job with no registered handler, explicitly and without retry", async () => {
        const { record } = await queue.enqueue(job({ type: "VERIFY_PROPOSAL" }));
        await queue.drain();
        expect(await queue.getJob(record.job.id)).toMatchObject({
          state: "FAILED",
          deadLettered: false,
          lastError: expect.stringContaining("VERIFY_PROPOSAL") as string,
        });
        expect(await queue.listDeadLetters()).toEqual([]);
      });

      it("draining an empty queue delivers nothing", async () => {
        expect(await queue.drain()).toBe(0);
      });
    });

    describe("retry", () => {
      it("delivers again after RETRY, counting attempts, and completes when the handler does", async () => {
        const { handler, calls } = scripted([
          { kind: "RETRY", reason: "model timed out" },
          { kind: "RETRY", reason: "model timed out again" },
          { kind: "COMPLETED" },
        ]);
        queue.register("ANALYZE_CHANGE", handler);
        const { record } = await queue.enqueue(job());
        expect(await queue.drain()).toBe(3);
        expect(calls).toEqual([1, 2, 3]);
        expect(await queue.getJob(record.job.id)).toMatchObject({
          state: "COMPLETED",
          job: { attempt: 3 },
          lastError: "model timed out again",
        });
        expect(transitions).toEqual([
          "->QUEUED@1",
          "QUEUED>RUNNING@1",
          "RUNNING>QUEUED@2:model timed out",
          "QUEUED>RUNNING@2",
          "RUNNING>QUEUED@3:model timed out again",
          "QUEUED>RUNNING@3",
          "RUNNING>COMPLETED@3",
        ]);
      });

      it("treats a thrown error as transient and retries with its message", async () => {
        let first = true;
        queue.register("ANALYZE_CHANGE", () => {
          if (first) {
            first = false;
            return Promise.reject(new Error("store unreachable"));
          }
          return Promise.resolve({ kind: "COMPLETED" });
        });
        const { record } = await queue.enqueue(job());
        await queue.drain();
        expect(await queue.getJob(record.job.id)).toMatchObject({
          state: "COMPLETED",
          job: { attempt: 2 },
        });
        // The reason names the request the failure happened in (TESTING.md §8).
        expect(transitions).toContain("RUNNING>QUEUED@2:store unreachable (correlation corr-1)");
      });
    });

    describe("terminal failure", () => {
      it("stops at FAILED when the handler says the job itself is wrong", async () => {
        const { handler, calls } = scripted([{ kind: "FAILED", reason: "proposal not approved" }]);
        queue.register("APPLY_PROPOSAL", handler);
        const { record } = await queue.enqueue(job({ type: "APPLY_PROPOSAL" }));
        await queue.drain();
        expect(calls).toEqual([1]);
        expect(await queue.getJob(record.job.id)).toMatchObject({
          state: "FAILED",
          deadLettered: false,
          lastError: "proposal not approved",
        });
        expect(transitions.at(-1)).toBe("RUNNING>FAILED@1:proposal not approved");
        expect(await queue.listDeadLetters()).toEqual([]);
      });

      it("gives up after maxAttempts deliveries and dead-letters the job", async () => {
        const { handler, calls } = scripted([
          { kind: "RETRY", reason: "flaky" },
          { kind: "RETRY", reason: "flaky" },
          { kind: "RETRY", reason: "still flaky" },
          { kind: "COMPLETED" },
        ]);
        queue.register("ANALYZE_CHANGE", handler);
        const { record } = await queue.enqueue(job());
        expect(await queue.drain()).toBe(3);
        expect(calls).toEqual([1, 2, 3]);
        const final = await queue.getJob(record.job.id);
        expect(final).toMatchObject({
          state: "FAILED",
          deadLettered: true,
          job: { attempt: 3 },
        });
        expect(final?.lastError).toContain("3 attempts");
        expect(final?.lastError).toContain("still flaky");
        expect((await queue.listDeadLetters()).map((entry) => entry.job.id)).toEqual([
          record.job.id,
        ]);
        // Draining again does not resurrect it.
        expect(await queue.drain()).toBe(0);
        expect(calls).toEqual([1, 2, 3]);
      });
    });

    describe("transitions", () => {
      it("carry the job's identity and correlation on every event", async () => {
        const seen: { jobId: string; productionId: string; correlationId: string }[] = [];
        queue.onTransition(({ jobId, productionId, correlationId }) => {
          seen.push({ jobId, productionId, correlationId });
        });
        queue.register("ANALYZE_CHANGE", () => Promise.resolve({ kind: "COMPLETED" }));
        const { record } = await queue.enqueue(job({ correlationId: "corr-9" }));
        await queue.drain();
        expect(seen).toHaveLength(3);
        expect(seen.every((entry) => entry.jobId === record.job.id)).toBe(true);
        expect(seen.every((entry) => entry.correlationId === "corr-9")).toBe(true);
        expect(seen.every((entry) => entry.productionId === "PROD-DEMO")).toBe(true);
      });

      it("stop listening when unsubscribed", async () => {
        const seen: string[] = [];
        const unsubscribe = queue.onTransition((transition) => {
          seen.push(transition.to);
        });
        queue.register("ANALYZE_CHANGE", () => Promise.resolve({ kind: "COMPLETED" }));
        await queue.enqueue(job());
        unsubscribe();
        await queue.drain();
        expect(seen).toEqual(["QUEUED"]);
      });
    });
  });
};
