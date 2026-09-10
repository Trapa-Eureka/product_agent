import { beforeEach, describe, expect, it } from "vitest";

import type { JobRun, ProposedOperation } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryJobRunRepository, createMemoryQueue } from "@pca/memory-queue";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";
import {
  createFakeModelAdapter,
  fixedClock,
  onDay,
  sequentialIds,
  withRepositoryFault,
} from "@pca/test-support";

import {
  InfrastructureError,
  bindQueueToJobTracker,
  createApplyApprovedProposal,
  createApplyProposalJobHandler,
  createCreateProposal,
  createDecideProposal,
  createInterpretChange,
  createJobTracker,
  createSimulateProposal,
  createSubmitChangeRequest,
  createVerifyAppliedProposal,
  guardRepositories,
  type RepositorySet,
} from "../src";

/**
 * Failure injection (TESTING.md §8, TASK-602).
 *
 * One place for every failure the product must survive: the store, a stale
 * version, an approval that does not match, a queue that has to retry, an
 * operation that can no longer apply, a verification that finds the world
 * wrong, and a model that does not answer. Each case asserts three things:
 * the outcome, that nothing was written that should not have been, and that
 * the message names the failing boundary and the correlation ID.
 */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T12:00:00.000Z";
const CORR = "corr-fault-1";

const golden1: ProposedOperation[] = [
  { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.tuesday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
];

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("failure injection", () => {
  let store: MemoryStore;
  let clock: ReturnType<typeof fixedClock>;
  let ids: ReturnType<typeof sequentialIds>;

  const useCases = (repositories: RepositorySet) => ({
    submit: createSubmitChangeRequest({ repositories, clock, ids }),
    create: createCreateProposal({ repositories, clock, ids }),
    decide: createDecideProposal({ repositories, clock, ids }),
    simulate: createSimulateProposal({ repositories }),
    apply: createApplyApprovedProposal({ repositories, clock, ids }),
    verify: createVerifyAppliedProposal({ repositories, clock, ids }),
  });

  /** Intake, proposal, approval on the healthy store; returns the IDs the apply needs. */
  const approvedGolden1 = async () => {
    const { submit, create, decide } = useCases(store);
    const submitted = await submit({
      productionId: DEMO,
      rawText: "Sarah cannot shoot Friday.",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      createdBy: "c",
      correlationId: CORR,
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    const created = await create({
      productionId: DEMO,
      changeRequestId: submitted.value.id,
      baseProductionVersion: 1,
      operations: golden1,
      summary: "Move Scene 07 and Scene 12 to Tuesday",
      proposedBy: "agent",
      correlationId: CORR,
    });
    if (!created.ok) throw new Error(created.error.message);
    const decided = await decide({
      productionId: DEMO,
      proposalId: created.value.id,
      decision: "APPROVE",
      decidedBy: "jinho@example.test",
      correlationId: CORR,
    });
    if (!decided.ok) throw new Error(decided.error.message);
    return { proposalId: created.value.id, approvalId: decided.value.approval.id };
  };

  const applyInput = (proposalId: string, approvalId: string) => ({
    productionId: DEMO,
    proposalId,
    approvalId,
    expectedProductionVersion: 1,
    idempotencyKey: "idem-key-apply-1",
    correlationId: CORR,
  });

  const unchanged = async () => {
    const state = await store.productions.loadState(DEMO);
    expect(state?.production.version).toBe(1);
    expect(state?.shootDays[0]?.sceneIds).toEqual([scenes.s07, scenes.s12]);
  };

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    clock = fixedClock(NOW);
    ids = sequentialIds();
  });

  describe("repository failure", () => {
    it("a store that fails mid-apply throws a named boundary and commits nothing", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const faulty = guardRepositories(
        "memory",
        withRepositoryFault(store, "productions", "commit", { error: new Error("socket hang up") }),
      );
      const { apply } = useCases(faulty);

      const failure = await apply(applyInput(proposalId, approvalId)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect((failure as InfrastructureError).boundary).toBe("memory.productions.commit");
      expect((failure as Error).message).toBe("memory.productions.commit failed: socket hang up");

      await unchanged();
      expect((await store.proposals.findById(DEMO, proposalId))?.status).toBe("APPROVED");
      expect(await store.idempotency.find(DEMO, "idem-key-apply-1")).toBeNull();
    });

    it("through the queue, the retry reason names the boundary and the correlation ID, and the second attempt applies exactly once", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const faulty = guardRepositories(
        "memory",
        withRepositoryFault(store, "productions", "commit", {
          error: new Error("socket hang up"),
          times: 1,
        }),
      );
      const { apply, verify } = useCases(faulty);
      const queue = createMemoryQueue({
        clock,
        ids,
        policy: { maxAttempts: 3, retryDelayMs: () => 0 },
      });
      const tracker = createJobTracker({ repository: createMemoryJobRunRepository(), clock, ids });
      bindQueueToJobTracker(queue, tracker);
      queue.register("APPLY_PROPOSAL", createApplyProposalJobHandler({ tracker, apply, verify }));
      const run = await tracker.start({
        productionId: DEMO,
        correlationId: CORR,
        type: "ANALYZE_CHANGE",
      });
      for (const stage of ["analyzing", "simulating", "validating", "awaiting_approval"] as const) {
        await tracker.advance(run.id, stage);
      }
      await queue.enqueue({
        type: "APPLY_PROPOSAL",
        productionId: DEMO,
        correlationId: CORR,
        idempotencyKey: "idem-key-apply-job",
        payload: {
          jobId: run.id,
          proposalId,
          approvalId,
          expectedProductionVersion: 1,
          idempotencyKey: "idem-key-apply-1",
        },
      });
      await queue.drain();
      await settle();

      const final = (await tracker.get(run.id)) as JobRun;
      expect(final.stage).toBe("completed");
      const retry = final.history.find((event) => event.message?.startsWith("Retrying"));
      expect(retry?.message).toBe(
        `Retrying (attempt 2): memory.productions.commit failed: socket hang up (correlation ${CORR})`,
      );
      expect(retry?.correlationId).toBe(CORR);
      expect(faulty.fault.failures()).toBe(1);
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(2);
      expect((await queue.listJobs())[0]).toMatchObject({
        state: "COMPLETED",
        job: { attempt: 2 },
      });
    });
  });

  describe("stale production version", () => {
    it("simulate and create refuse a base version the production has left behind, naming both versions", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const { apply, simulate, create } = useCases(store);
      const applied = await apply(applyInput(proposalId, approvalId));
      expect(applied.ok).toBe(true);

      const simulated = await simulate({
        productionId: DEMO,
        baseProductionVersion: 1,
        operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday }],
        correlationId: CORR,
      });
      expect(!simulated.ok && simulated.error).toMatchObject({
        code: "PRODUCTION_VERSION_MISMATCH",
        correlationId: CORR,
        // "expected" is what the caller prepared against; "actual" is where the production is now.
        expected: "1",
        actual: "2",
      });
      const created = await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday }],
        summary: "late",
        proposedBy: "agent",
        correlationId: CORR,
      });
      expect(!created.ok && created.error.code).toBe("PRODUCTION_VERSION_MISMATCH");
      expect(await store.proposals.findById(DEMO, "P-2")).toBeNull();
    });

    it("apply refuses an expected version that no longer matches and writes nothing", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const { apply } = useCases(store);
      const result = await apply({
        ...applyInput(proposalId, approvalId),
        expectedProductionVersion: 2,
      });
      expect(!result.ok && result.error).toMatchObject({
        code: "PRODUCTION_VERSION_MISMATCH",
        correlationId: CORR,
        nextStep: expect.stringMatching(/re-?load|re-?run|simulat/iu) as string,
      });
      await unchanged();
      expect((await store.proposals.findById(DEMO, proposalId))?.status).toBe("APPROVED");
    });
  });

  describe("approval mismatch", () => {
    it("an approval for another proposal is refused, and nothing is written", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const { create, decide, apply } = useCases(store);
      const other = await create({
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday }],
        summary: "other",
        proposedBy: "agent",
      });
      if (!other.ok) throw new Error(other.error.message);
      const otherDecision = await decide({
        productionId: DEMO,
        proposalId: other.value.id,
        decision: "APPROVE",
        decidedBy: "jinho@example.test",
      });
      if (!otherDecision.ok) throw new Error(otherDecision.error.message);

      const crossed = await apply({
        ...applyInput(proposalId, approvalId),
        approvalId: otherDecision.value.approval.id,
      });
      expect(!crossed.ok && crossed.error).toMatchObject({
        code: "APPROVAL_MISMATCH",
        correlationId: CORR,
      });
      expect(!crossed.ok && crossed.error.message).toContain(proposalId);
      await unchanged();
    });

    it("a proposal edited after approval no longer matches its digest and cannot be applied (INV-6)", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const proposal = await store.proposals.findById(DEMO, proposalId);
      await store.proposals.save({
        ...(proposal as NonNullable<typeof proposal>),
        digest: "f".repeat(64),
      });
      const { apply } = useCases(store);
      const result = await apply(applyInput(proposalId, approvalId));
      // The guard treats an edited proposal as invalid rather than as a wrong approval: the
      // approval was right for the proposal that existed; the proposal is what changed.
      expect(!result.ok && result.error).toMatchObject({
        code: "PROPOSAL_INVALID",
        correlationId: CORR,
      });
      expect(!result.ok && result.error.message).toMatch(/digest/iu);
      await unchanged();
    });
  });

  describe("queue retry", () => {
    it("exhausted attempts dead-letter the job and fail the run with the boundary and correlation ID", async () => {
      const queue = createMemoryQueue({
        clock,
        ids,
        policy: { maxAttempts: 2, retryDelayMs: () => 0 },
      });
      const tracker = createJobTracker({ repository: createMemoryJobRunRepository(), clock, ids });
      bindQueueToJobTracker(queue, tracker);
      queue.register("ANALYZE_CHANGE", () =>
        Promise.reject(
          new InfrastructureError("mongo.changeRequests.save", new Error("write conflict")),
        ),
      );
      const run = await tracker.start({
        productionId: DEMO,
        correlationId: CORR,
        type: "ANALYZE_CHANGE",
      });
      await queue.enqueue({
        type: "ANALYZE_CHANGE",
        productionId: DEMO,
        correlationId: CORR,
        idempotencyKey: "idem-key-analyze",
        payload: { jobId: run.id, text: "Sarah cannot shoot Friday.", requestedBy: "c" },
      });
      await queue.drain();
      await settle();

      const dead = await queue.listDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]?.lastError).toBe(
        `Gave up after 2 attempts. Last reason: mongo.changeRequests.save failed: write conflict (correlation ${CORR})`,
      );
      const final = (await tracker.get(run.id)) as JobRun;
      expect(final.stage).toBe("failed");
      expect(final.message).toContain("mongo.changeRequests.save");
      expect(final.message).toContain(CORR);
      expect(final.history.every((event) => event.correlationId === CORR)).toBe(true);
    });
  });

  describe("partial operation failure", () => {
    it("a proposal whose second operation can no longer apply is refused whole; nothing from it is committed", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      // Scene 12 leaves Friday behind the proposal's back (an admin edit, no version bump).
      const state = createDemoMovie();
      await store.productions.save({
        ...state,
        shootDays: state.shootDays.map((day) =>
          day.id === shootDays.friday ? { ...day, sceneIds: [scenes.s07] } : day,
        ),
      });
      const { apply } = useCases(store);
      const result = await apply(applyInput(proposalId, approvalId));
      expect(!result.ok && result.error).toMatchObject({
        code: "PROPOSAL_INVALID",
        correlationId: CORR,
      });
      expect(!result.ok && result.error.message).toContain(proposalId);
      expect(!result.ok && result.error.message).toMatch(/Scene 12|S12/u);

      const after = await store.productions.loadState(DEMO);
      expect(after?.production.version).toBe(1);
      // The fact operation (first in the plan) was not applied either: all or nothing.
      expect(after?.castMembers.find((member) => member.id === cast.sarah)?.unavailable).toEqual(
        [],
      );
      expect(after?.callSheets.find((sheet) => sheet.id === callSheets.friday)?.status).toBe(
        "PUBLISHED",
      );
      expect((await store.proposals.findById(DEMO, proposalId))?.status).toBe("FAILED");
      const audit = await store.auditEvents.list(DEMO);
      expect(audit[0]).toMatchObject({ action: "PROPOSAL_APPLY_FAILED", correlationId: CORR });
    });
  });

  describe("verification failure", () => {
    it("a world that no longer matches the applied proposal fails verification, naming the check", async () => {
      const { proposalId, approvalId } = await approvedGolden1();
      const { apply, verify } = useCases(store);
      const applied = await apply(applyInput(proposalId, approvalId));
      expect(applied.ok).toBe(true);
      // Someone moves Scene 07 back to Friday by hand.
      const state = (await store.productions.loadState(DEMO)) as NonNullable<
        Awaited<ReturnType<typeof store.productions.loadState>>
      >;
      await store.productions.save({
        ...state,
        shootDays: state.shootDays.map((day) => {
          if (day.id === shootDays.friday) return { ...day, sceneIds: [scenes.s07] };
          if (day.id === shootDays.tuesday)
            return { ...day, sceneIds: day.sceneIds.filter((id) => id !== scenes.s07) };
          return day;
        }),
      });

      const verified = await verify({ productionId: DEMO, proposalId, correlationId: CORR });
      if (!verified.ok) throw new Error(verified.error.message);
      expect(verified.value.success).toBe(false);
      const failing = verified.value.checks.filter((check) => !check.passed);
      expect(failing.length).toBeGreaterThan(0);
      expect(failing.map((check) => check.name).join(" ")).toMatch(/MOVE_SCENES|scene/iu);
      const audit = await store.auditEvents.list(DEMO);
      expect(audit[0]).toMatchObject({ correlationId: CORR });
      expect(audit[0]?.action).toMatch(/VERIF/u);
    });
  });

  describe("model provider failure", () => {
    it("a provider that hangs becomes an INTERNAL_ERROR with the correlation ID and a retry hint, never a prompt", async () => {
      const interpret = createInterpretChange({
        repositories: store,
        model: createFakeModelAdapter({ misbehave: "hang" }),
        clock,
        modelTimeoutMs: 20,
      });
      const result = await interpret({
        productionId: DEMO,
        text: "Sarah cannot shoot Friday.",
        correlationId: CORR,
      });
      expect(!result.ok && result.error).toMatchObject({
        code: "INTERNAL_ERROR",
        correlationId: CORR,
        actual: "TIMEOUT",
        nextStep: expect.stringContaining("correlation ID") as string,
      });
      expect(!result.ok && result.error.message).not.toContain("Sarah");
      expect(await store.changeRequests.findById(DEMO, "CR-1")).toBeNull();
    });

    it("a provider that answers with something ungrounded is refused the same way", async () => {
      const interpret = createInterpretChange({
        repositories: store,
        model: createFakeModelAdapter({ misbehave: "hallucinate" }),
        clock,
      });
      const result = await interpret({
        productionId: DEMO,
        text: "Sarah cannot shoot Friday.",
        correlationId: CORR,
      });
      expect(!result.ok && result.error).toMatchObject({
        code: "INTERNAL_ERROR",
        correlationId: CORR,
        actual: "UNGROUNDED_OUTPUT",
      });
    });

    it("the healthy rule adapter still interprets the same sentence, so the failure was the provider's", async () => {
      const interpret = createInterpretChange({
        repositories: store,
        model: createRuleModelAdapter(),
        clock,
      });
      const result = await interpret({
        productionId: DEMO,
        text: "Sarah cannot shoot Friday.",
        correlationId: CORR,
      });
      expect(result.ok && result.value.kind).toBe("RESOLVED");
    });
  });
});
