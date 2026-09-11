import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "@pca/contracts";
import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { fixedClock, sequentialIds } from "@pca/test-support";

import {
  JobBindingError,
  advanceJobRun,
  createApplyProposalJobHandler,
  createJobTracker,
  createVerifyProposalJobHandler,
  describeJobMismatch,
  startJobRun,
  type JobTracker,
} from "../src";

const NOW = "2026-09-10T12:00:00.000Z";
const DEMO = "PROD-DEMO";

const neverCalled = (): never => {
  throw new Error("must not be called");
};

/** A run that produced proposal P-1 and is awaiting the decision. */
const awaiting = async (tracker: JobTracker) => {
  const run = await tracker.start({
    productionId: DEMO,
    correlationId: "corr-1",
    type: "ANALYZE_CHANGE",
    requestedBy: "jinho@example.test",
  });
  for (const stage of ["analyzing", "simulating", "validating"] as const) {
    await tracker.advance(run.id, stage);
  }
  return tracker.advance(run.id, "awaiting_approval", { proposalId: "P-1" });
};

describe("job binding (TASK-919, SEC-008 / AUD-012)", () => {
  describe("describeJobMismatch", () => {
    const run = startJobRun({
      id: "JOB-1",
      productionId: DEMO,
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
      now: NOW,
      requestedBy: "jinho@example.test",
    }).run;
    const atAwaiting = { ...run, stage: "awaiting_approval" as const, proposalId: "P-1" };

    it("is silent when the job is the one asked for", () => {
      expect(
        describeJobMismatch(atAwaiting, {
          productionId: DEMO,
          type: "ANALYZE_CHANGE",
          proposalId: "P-1",
          stages: ["awaiting_approval"],
          requestedBy: "jinho@example.test",
        }),
      ).toBeNull();
    });

    it("names the production, type, proposal, stage, or owner that does not match", () => {
      expect(describeJobMismatch(null, { productionId: DEMO })?.code).toBe("ENTITY_NOT_FOUND");
      expect(describeJobMismatch(run, { productionId: "PROD-OTHER" })?.code).toBe(
        "ENTITY_NOT_FOUND",
      );
      expect(
        describeJobMismatch(run, { productionId: DEMO, type: "APPLY_PROPOSAL" }),
      ).toMatchObject({
        code: "JOB_MISMATCH",
        expected: "APPLY_PROPOSAL",
        actual: "ANALYZE_CHANGE",
      });
      expect(
        describeJobMismatch(atAwaiting, { productionId: DEMO, proposalId: "P-2" }),
      ).toMatchObject({ code: "JOB_MISMATCH", expected: "P-2", actual: "P-1" });
      expect(
        describeJobMismatch(run, { productionId: DEMO, proposalId: "P-1" })?.message,
      ).toContain("has not produced a proposal");
      expect(
        describeJobMismatch(atAwaiting, { productionId: DEMO, stages: ["resolving"] }),
      ).toMatchObject({ code: "JOB_MISMATCH", expected: "resolving", actual: "awaiting_approval" });
      expect(
        describeJobMismatch(run, { productionId: DEMO, requestedBy: "mina@example.test" }),
      ).toMatchObject({ code: "TOOL_UNAUTHORIZED" });
      // A run that never recorded an owner is not locked to anyone.
      const { requestedBy: _owner, ...unowned } = run;
      expect(
        describeJobMismatch(unowned, { productionId: DEMO, requestedBy: "mina@example.test" }),
      ).toBeNull();
    });
  });

  describe("advanceJobRun with an expectation", () => {
    const run = {
      ...startJobRun({
        id: "JOB-1",
        productionId: DEMO,
        correlationId: "corr-1",
        type: "ANALYZE_CHANGE",
        now: NOW,
      }).run,
      stage: "awaiting_approval" as const,
      proposalId: "P-1",
    };

    it("moves when the run matches and refuses, untouched, when it does not", () => {
      expect(
        advanceJobRun(run, "applying", NOW, {
          expect: { stage: "awaiting_approval", proposalId: "P-1" },
        }).run.stage,
      ).toBe("applying");
      expect(() => advanceJobRun(run, "applying", NOW, { expect: { proposalId: "P-2" } })).toThrow(
        JobBindingError,
      );
      expect(() => advanceJobRun(run, "applying", NOW, { expect: { stage: "resolving" } })).toThrow(
        /is at awaiting_approval, not resolving/u,
      );
    });
  });

  describe("queue handlers", () => {
    const envelope = (payload: unknown): JobEnvelope => ({
      id: "Q-1",
      type: "APPLY_PROPOSAL",
      productionId: DEMO,
      correlationId: "corr-1",
      idempotencyKey: "apply:idem-key-0001",
      attempt: 1,
      payload,
    });

    it("apply: a payload naming another proposal fails the queue job and leaves the run untouched", async () => {
      const tracker = createJobTracker({
        repository: createMemoryJobRunRepository(),
        clock: fixedClock(NOW),
        ids: sequentialIds(),
      });
      const run = await awaiting(tracker);
      const handler = createApplyProposalJobHandler({
        tracker,
        apply: neverCalled,
        verify: neverCalled,
      });
      const outcome = await handler(
        envelope({
          jobId: run.id,
          proposalId: "P-2",
          approvalId: "A-1",
          expectedProductionVersion: 1,
          idempotencyKey: "idem-key-0001",
        }),
      );
      expect(outcome).toMatchObject({ kind: "FAILED" });
      expect(outcome.kind === "FAILED" && outcome.reason).toContain("belongs to proposal P-1");
      const after = await tracker.get(run.id);
      expect(after).toMatchObject({
        stage: "awaiting_approval",
        status: "STARTED",
        proposalId: "P-1",
      });
      expect(after?.history).toHaveLength(run.history.length);
    });

    it("verify: the same for a verification naming another proposal", async () => {
      const tracker = createJobTracker({
        repository: createMemoryJobRunRepository(),
        clock: fixedClock(NOW),
        ids: sequentialIds(),
      });
      const run = await awaiting(tracker);
      await tracker.advance(run.id, "applying");
      await tracker.advance(run.id, "verifying");
      const handler = createVerifyProposalJobHandler({
        tracker,
        verify: neverCalled,
      });
      const outcome = await handler({
        ...envelope({ jobId: run.id, proposalId: "P-9" }),
        type: "VERIFY_PROPOSAL",
      });
      expect(outcome.kind).toBe("FAILED");
      expect((await tracker.get(run.id))?.stage).toBe("verifying");
    });
  });
});
