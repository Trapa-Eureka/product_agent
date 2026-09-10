import { beforeEach, describe, expect, it } from "vitest";

import type { AgentJobEvent, JobRun } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import {
  createMemoryJobRunRepository,
  createMemoryQueue,
  type MemoryQueue,
} from "@pca/memory-queue";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";
import { fixedClock, onDay, sequentialIds } from "@pca/test-support";

import {
  bindQueueToJobTracker,
  createAnalyzeChangeJobHandler,
  createApplyApprovedProposal,
  createApplyProposalJobHandler,
  createDecideProposal,
  createJobTracker,
  createRunChangeAgent,
  createVerifyAppliedProposal,
  createVerifyProposalJobHandler,
  fail,
  succeed,
  type ApplyApprovedProposal,
  type EnqueueJobInput,
  type JobTracker,
  type RunChangeAgent,
  type VerifyAppliedProposal,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast } = DEMO_MOVIE_IDS;
const { friday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T12:00:00.000Z";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const timeline = (run: JobRun | null): string[] =>
  (run?.history ?? []).map((event) => `${event.stage}:${event.status}`);

describe("job handlers", () => {
  let store: MemoryStore;
  let queue: MemoryQueue;
  let tracker: JobTracker;
  let events: AgentJobEvent[];
  let runChangeAgent: RunChangeAgent;
  let apply: ApplyApprovedProposal;
  let verify: VerifyAppliedProposal;

  const envelope = (
    type: EnqueueJobInput["type"],
    payload: unknown,
    idempotencyKey = "idem-key-0001",
  ): EnqueueJobInput => ({
    type,
    productionId: DEMO,
    correlationId: "corr-1",
    idempotencyKey,
    payload,
  });

  const analyzeJob = async (text: string, extra: Record<string, unknown> = {}) => {
    const run = await tracker.start({
      productionId: DEMO,
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
    });
    await queue.enqueue(
      envelope(
        "ANALYZE_CHANGE",
        { jobId: run.id, text, requestedBy: "c", ...extra },
        `idem-${run.id}-analyze`,
      ),
    );
    await queue.drain();
    await settle();
    return (await tracker.get(run.id)) as JobRun;
  };

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    const clock = fixedClock(NOW);
    const ids = sequentialIds();
    queue = createMemoryQueue({ clock, ids, policy: { maxAttempts: 2, retryDelayMs: () => 0 } });
    tracker = createJobTracker({ repository: createMemoryJobRunRepository(), clock, ids });
    events = [];
    tracker.onEvent((event) => events.push(event));
    bindQueueToJobTracker(queue, tracker);

    runChangeAgent = createRunChangeAgent({
      repositories: store,
      model: createRuleModelAdapter(),
      clock,
      ids,
    });
    apply = createApplyApprovedProposal({ repositories: store, clock, ids });
    verify = createVerifyAppliedProposal({ repositories: store, clock, ids });
    queue.register("ANALYZE_CHANGE", createAnalyzeChangeJobHandler({ tracker, runChangeAgent }));
    queue.register("APPLY_PROPOSAL", createApplyProposalJobHandler({ tracker, apply, verify }));
  });

  describe("ANALYZE_CHANGE", () => {
    it("GOLDEN-1: walks received → resolving → analyzing → simulating → validating → awaiting_approval", async () => {
      const run = await analyzeJob("Sarah cannot shoot Friday.");
      expect(timeline(run)).toEqual([
        "received:STARTED",
        "received:COMPLETED",
        "resolving:STARTED",
        "resolving:COMPLETED",
        "analyzing:STARTED",
        "analyzing:COMPLETED",
        "simulating:STARTED",
        "simulating:COMPLETED",
        "validating:STARTED",
        "validating:COMPLETED",
        "awaiting_approval:STARTED",
      ]);
      expect(run).toMatchObject({
        stage: "awaiting_approval",
        status: "STARTED",
        message: "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
        changeRequestId: "CR-1",
      });
      expect(run.proposalId).toMatch(/^P-/);
      expect(events).toEqual(run.history);
      expect((await queue.listJobs())[0]?.state).toBe("COMPLETED");
    });

    it("waits at resolving with the question when the sentence is ambiguous, then continues once resolved", async () => {
      const state = createDemoMovie();
      await store.productions.save({
        ...state,
        castMembers: [
          ...state.castMembers,
          { id: "CAST-SARAH-2", productionId: DEMO, name: "Sarah", unavailable: [] },
        ],
      });
      const waiting = await analyzeJob("Sarah cannot shoot Friday.");
      expect(waiting).toMatchObject({ stage: "resolving", status: "STARTED" });
      expect(waiting.message).toContain("Which one?");
      expect(timeline(waiting).at(-1)).toBe("resolving:STARTED");

      await queue.enqueue(
        envelope(
          "ANALYZE_CHANGE",
          {
            jobId: waiting.id,
            text: "Sarah cannot shoot Friday.",
            change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
            requestedBy: "c",
          },
          "idem-key-resolved",
        ),
      );
      await queue.drain();
      await settle();
      const resumed = await tracker.get(waiting.id);
      expect(resumed?.stage).toBe("awaiting_approval");
      expect(timeline(resumed).slice(timeline(waiting).length)).toEqual([
        "resolving:COMPLETED",
        "analyzing:STARTED",
        "analyzing:COMPLETED",
        "simulating:STARTED",
        "simulating:COMPLETED",
        "validating:STARTED",
        "validating:COMPLETED",
        "awaiting_approval:STARTED",
      ]);
    });

    it("skips resolving when the change arrives already resolved", async () => {
      const run = await analyzeJob("Sarah cannot shoot Friday.", {
        change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      });
      expect(timeline(run).slice(0, 3)).toEqual([
        "received:STARTED",
        "received:COMPLETED",
        "analyzing:STARTED",
      ]);
      expect(run.stage).toBe("awaiting_approval");
    });

    it("completes from analyzing when there is nothing to propose", async () => {
      const run = await analyzeJob("Scene 07 now needs a crowbar.");
      expect(run.stage).toBe("completed");
      expect(timeline(run).slice(-3)).toEqual([
        "analyzing:STARTED",
        "analyzing:COMPLETED",
        "completed:COMPLETED",
      ]);
      expect(run.message).toContain("already");
    });

    it("fails the run, and the queue job without retry, when the change cannot be interpreted", async () => {
      const run = await analyzeJob("Make it better.");
      expect(run).toMatchObject({ stage: "failed", status: "FAILED" });
      expect(run.message).toMatch(/^UNSUPPORTED_CHANGE:/);
      expect(timeline(run).at(-1)).toBe("resolving:FAILED");
      const [job] = await queue.listJobs();
      expect(job).toMatchObject({ state: "FAILED", deadLettered: false, job: { attempt: 1 } });
    });

    it("fails at validating when the proposal it built is invalid", async () => {
      const run = await tracker.start({
        productionId: DEMO,
        correlationId: "corr-1",
        type: "ANALYZE_CHANGE",
      });
      const handler = createAnalyzeChangeJobHandler({
        tracker,
        runChangeAgent: async (input) => {
          await input.progress?.("analyzing");
          await input.progress?.("simulating");
          await input.progress?.("validating");
          const { progress: _progress, ...rest } = input;
          const real = await runChangeAgent(rest);
          if (!real.ok || real.value.kind !== "PROPOSED") throw new Error("expected PROPOSED");
          return succeed({
            ...real.value,
            proposal: {
              ...real.value.proposal,
              validationStatus: "INVALID",
              status: "DRAFT",
              conflicts: [
                {
                  code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
                  entityType: "SCENE",
                  entityId: "S07",
                  date: friday,
                  detail: "Scene 07 still conflicts.",
                },
              ],
            },
          });
        },
      });
      queue.register("ANALYZE_CHANGE", handler);
      await queue.enqueue(
        envelope("ANALYZE_CHANGE", {
          jobId: run.id,
          text: "Sarah cannot shoot Friday.",
          requestedBy: "c",
        }),
      );
      await queue.drain();
      await settle();
      const final = await tracker.get(run.id);
      expect(final).toMatchObject({
        stage: "failed",
        message: expect.stringContaining("Scene 07 still conflicts.") as string,
      });
      expect(timeline(final).at(-1)).toBe("validating:FAILED");
    });

    it("fails a malformed payload and a job that was never started, without touching the store", async () => {
      queue.register("ANALYZE_CHANGE", createAnalyzeChangeJobHandler({ tracker, runChangeAgent }));
      await queue.enqueue(envelope("ANALYZE_CHANGE", { text: "x" }, "idem-key-bad1"));
      await queue.enqueue(
        envelope(
          "ANALYZE_CHANGE",
          { jobId: "JOB-404", text: "x", requestedBy: "c" },
          "idem-key-bad2",
        ),
      );
      await queue.drain();
      await settle();
      const jobs = await queue.listJobs();
      expect(jobs.map((job) => job.state)).toEqual(["FAILED", "FAILED"]);
      expect(jobs[0]?.lastError).toContain("malformed payload");
      expect(jobs[1]?.lastError).toContain("never started");
      expect(await store.changeRequests.findById(DEMO, "CR-1")).toBeNull();
    });
  });

  describe("APPLY_PROPOSAL", () => {
    const approveAndApply = async (run: JobRun) => {
      const decide = createDecideProposal({
        repositories: store,
        clock: fixedClock(NOW),
        ids: sequentialIds(),
      });
      const decided = await decide({
        productionId: DEMO,
        proposalId: run.proposalId as string,
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      if (!decided.ok) throw new Error(decided.error.message);
      await queue.enqueue(
        envelope(
          "APPLY_PROPOSAL",
          {
            jobId: run.id,
            proposalId: run.proposalId,
            approvalId: decided.value.approval.id,
            expectedProductionVersion: 1,
            idempotencyKey: "idem-key-apply-1",
            appliedBy: "jinho@example.test",
          },
          "idem-key-apply-job",
        ),
      );
      await queue.drain();
      await settle();
      return (await tracker.get(run.id)) as JobRun;
    };

    it("GOLDEN-1: applies and verifies, walking awaiting_approval → applying → verifying → completed", async () => {
      const proposed = await analyzeJob("Sarah cannot shoot Friday.");
      const done = await approveAndApply(proposed);
      expect(timeline(done).slice(timeline(proposed).length)).toEqual([
        "awaiting_approval:COMPLETED",
        "applying:STARTED",
        "applying:COMPLETED",
        "verifying:STARTED",
        "verifying:COMPLETED",
        "completed:COMPLETED",
      ]);
      expect(done.message).toContain("applied and verified");
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(2);
    });

    it("redelivered after a transient verification failure, it verifies without applying again", async () => {
      const proposed = await analyzeJob("Sarah cannot shoot Friday.");
      let applyCalls = 0;
      let verifyCalls = 0;
      queue.register(
        "APPLY_PROPOSAL",
        createApplyProposalJobHandler({
          tracker,
          apply: (input) => {
            applyCalls += 1;
            return apply(input);
          },
          verify: (input) => {
            verifyCalls += 1;
            if (verifyCalls === 1) return Promise.reject(new Error("store unreachable"));
            return verify(input);
          },
        }),
      );
      const done = await approveAndApply(proposed);
      expect(applyCalls).toBe(1);
      expect(verifyCalls).toBe(2);
      expect(done.stage).toBe("completed");
      expect(timeline(done).filter((entry) => entry === "verifying:STARTED")).toHaveLength(2);
      expect(
        done.history.find((event) => event.message?.startsWith("Retrying (attempt 2)")),
      ).toBeDefined();
      expect((await queue.listJobs()).at(-1)).toMatchObject({
        state: "COMPLETED",
        job: { attempt: 2 },
      });
    });

    it("refuses to apply a job that is not awaiting approval", async () => {
      const run = await tracker.start({
        productionId: DEMO,
        correlationId: "corr-1",
        type: "APPLY_PROPOSAL",
      });
      await queue.enqueue(
        envelope("APPLY_PROPOSAL", {
          jobId: run.id,
          proposalId: "P-1",
          approvalId: "A-1",
          expectedProductionVersion: 1,
          idempotencyKey: "idem-key-apply-1",
        }),
      );
      await queue.drain();
      await settle();
      expect(await tracker.get(run.id)).toMatchObject({
        stage: "failed",
        message: expect.stringContaining("only a job awaiting approval") as string,
      });
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(1);
    });

    it("fails the run when the apply use case refuses (stale version), without retry", async () => {
      const proposed = await analyzeJob("Sarah cannot shoot Friday.");
      queue.register(
        "APPLY_PROPOSAL",
        createApplyProposalJobHandler({
          tracker,
          apply: () =>
            Promise.resolve(
              fail("PRODUCTION_VERSION_MISMATCH", "The production moved on.", {
                expected: "1",
                actual: "2",
              }),
            ),
          verify,
        }),
      );
      const done = await approveAndApply(proposed);
      expect(done).toMatchObject({
        stage: "failed",
        message: "PRODUCTION_VERSION_MISMATCH: The production moved on.",
      });
      expect(timeline(done).at(-1)).toBe("applying:FAILED");
      expect((await queue.listJobs()).at(-1)).toMatchObject({
        state: "FAILED",
        job: { attempt: 1 },
      });
    });
  });

  describe("VERIFY_PROPOSAL", () => {
    it("verifies a job at verifying and completes it", async () => {
      const proposed = await analyzeJob("Sarah cannot shoot Friday.");
      await tracker.advance(proposed.id, "applying");
      const decide = createDecideProposal({
        repositories: store,
        clock: fixedClock(NOW),
        ids: sequentialIds(),
      });
      const decided = await decide({
        productionId: DEMO,
        proposalId: proposed.proposalId as string,
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      if (!decided.ok) throw new Error(decided.error.message);
      const applied = await apply({
        productionId: DEMO,
        proposalId: proposed.proposalId as string,
        approvalId: decided.value.approval.id,
        expectedProductionVersion: 1,
        idempotencyKey: "idem-key-apply-1",
      });
      if (!applied.ok) throw new Error(applied.error.message);
      await tracker.advance(proposed.id, "verifying");

      queue.register("VERIFY_PROPOSAL", createVerifyProposalJobHandler({ tracker, verify }));
      await queue.enqueue(
        envelope(
          "VERIFY_PROPOSAL",
          { jobId: proposed.id, proposalId: proposed.proposalId },
          "idem-key-verify",
        ),
      );
      await queue.drain();
      await settle();
      expect((await tracker.get(proposed.id))?.stage).toBe("completed");
    });

    it("fails a job that is not at verifying", async () => {
      const proposed = await analyzeJob("Sarah cannot shoot Friday.");
      queue.register("VERIFY_PROPOSAL", createVerifyProposalJobHandler({ tracker, verify }));
      await queue.enqueue(
        envelope(
          "VERIFY_PROPOSAL",
          { jobId: proposed.id, proposalId: proposed.proposalId },
          "idem-key-verify",
        ),
      );
      await queue.drain();
      await settle();
      expect(await tracker.get(proposed.id)).toMatchObject({
        stage: "failed",
        message: expect.stringContaining("only an applied job can be verified") as string,
      });
    });
  });

  describe("queue binding", () => {
    it("fails the run when the queue cannot deliver the job at all", async () => {
      const run = await tracker.start({
        productionId: DEMO,
        correlationId: "corr-1",
        type: "VERIFY_PROPOSAL",
      });
      await queue.enqueue(envelope("VERIFY_PROPOSAL", { jobId: run.id, proposalId: "P-1" }));
      await queue.drain();
      await settle();
      expect(await tracker.get(run.id)).toMatchObject({
        stage: "failed",
        message: expect.stringContaining("No handler is registered") as string,
      });
    });

    it("announces retries on the current stage and fails the run when attempts run out", async () => {
      const run = await tracker.start({
        productionId: DEMO,
        correlationId: "corr-1",
        type: "ANALYZE_CHANGE",
      });
      queue.register("ANALYZE_CHANGE", () => Promise.reject(new Error("store unreachable")));
      await queue.enqueue(
        envelope("ANALYZE_CHANGE", {
          jobId: run.id,
          text: "Sarah cannot shoot Friday.",
          requestedBy: "c",
        }),
      );
      await queue.drain();
      await settle();
      const final = await tracker.get(run.id);
      expect(final?.history.map((event) => event.message)).toEqual([
        undefined,
        "Retrying (attempt 2): store unreachable (correlation corr-1)",
        expect.stringContaining("Gave up after 2 attempts") as string,
      ]);
      expect(final?.stage).toBe("failed");
      expect((await queue.listDeadLetters()).map((entry) => entry.job.attempt)).toEqual([2]);
    });

    it("leaves a run alone once it is terminal", async () => {
      const run = await analyzeJob("Make it better.");
      expect(run.stage).toBe("failed");
      const before = run.history.length;
      queue.redeliver((await queue.listJobs())[0]?.job.id as string);
      await queue.drain();
      await settle();
      expect((await tracker.get(run.id))?.history).toHaveLength(before);
    });
  });
});
