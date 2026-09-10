import { z } from "zod";

import type { EntityId, JobEnvelope, ToolError } from "@pca/contracts";
import {
  analyzeChangeJobPayloadSchema,
  applyProposalJobPayloadSchema,
  verifyProposalJobPayloadSchema,
} from "@pca/contracts";

import type { JobHandler, JobHandlerOutcome, QueuePort } from "../ports";
import type { ApplyApprovedProposal } from "../use-cases/apply-approved-proposal";
import type { RunChangeAgent } from "../use-cases/run-change-agent";
import type { VerifyAppliedProposal } from "../use-cases/verify-applied-proposal";
import type { JobTracker } from "./job-tracker";
import { isTerminalStage } from "./stage-machine";

/**
 * Queue handlers that drive the job stage machine (TASK-403).
 *
 * The queue decides *whether* a job runs again; the tracker decides *where*
 * it is. A handler reads the run's current stage before acting, which is
 * what makes redelivery safe: an apply job delivered again after a crash
 * mid-verification verifies without applying twice.
 *
 * Use-case errors are values and mean the job itself cannot succeed, so the
 * run fails and the handler answers `FAILED`. Exceptions mean the
 * infrastructure failed, so they propagate and the queue retries.
 */

const failed = (error: ToolError): JobHandlerOutcome => ({
  kind: "FAILED",
  reason: `${error.code}: ${error.message}`,
});

const malformed = (envelope: JobEnvelope, issue: string): JobHandlerOutcome => ({
  kind: "FAILED",
  reason: `Job ${envelope.id} (${envelope.type}) has a malformed payload: ${issue}.`,
});

const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  return `${issue?.path.join(".") ?? "<root>"} ${issue?.message ?? "is invalid"}`;
};

/** ANALYZE_CHANGE: received → resolving → analyzing → simulating → validating → awaiting_approval. */
export const createAnalyzeChangeJobHandler = (dependencies: {
  readonly tracker: JobTracker;
  readonly runChangeAgent: RunChangeAgent;
}): JobHandler => {
  const { tracker, runChangeAgent } = dependencies;

  return async (envelope) => {
    const parsed = analyzeChangeJobPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return malformed(envelope, describeIssue(parsed.error));
    const { jobId, text, change, requestedBy } = parsed.data;

    const run = await tracker.get(jobId);
    if (run === null) return { kind: "FAILED", reason: `Job ${jobId} was never started.` };
    if (isTerminalStage(run.stage)) return { kind: "COMPLETED" };

    // A change the user already resolved skips interpretation; otherwise the
    // run may already be at `resolving`, waiting on the user's answer.
    if (run.stage === "received") {
      await tracker.advance(jobId, change === undefined ? "resolving" : "analyzing");
    } else if (run.stage === "resolving" && change !== undefined) {
      await tracker.advance(jobId, "analyzing");
    }

    const result = await runChangeAgent({
      productionId: envelope.productionId,
      text,
      ...(change === undefined ? {} : { change }),
      requestedBy,
      correlationId: envelope.correlationId,
      progress: async (stage) => {
        const current = await tracker.get(jobId);
        if (current !== null && current.stage !== stage) await tracker.advance(jobId, stage);
      },
    });

    if (!result.ok) {
      await tracker.fail(jobId, `${result.error.code}: ${result.error.message}`);
      return failed(result.error);
    }

    const outcome = result.value;
    switch (outcome.kind) {
      case "NEEDS_RESOLUTION":
        await tracker.note(jobId, outcome.question);
        return { kind: "COMPLETED" };
      case "PROPOSED": {
        const { proposal } = outcome;
        if (proposal.validationStatus === "INVALID") {
          await tracker.fail(
            jobId,
            `Proposal ${proposal.id} is invalid: ${proposal.conflicts[0]?.detail ?? "conflicts remain"}`,
          );
          return { kind: "FAILED", reason: `Proposal ${proposal.id} is invalid.` };
        }
        await tracker.advance(jobId, "awaiting_approval", {
          message: outcome.explanation.headline,
          changeRequestId: outcome.changeRequest.id,
          proposalId: proposal.id,
        });
        return { kind: "COMPLETED" };
      }
      case "NO_CANDIDATE":
        await tracker.advance(jobId, "completed", {
          message: `No shoot day can take the affected scenes. ${outcome.explanation}`,
          changeRequestId: outcome.changeRequest.id,
        });
        return { kind: "COMPLETED" };
      case "NOTHING_TO_DO": {
        // The engine's own reason ("Scene 07 already has ...") over the model's prose.
        const reason = outcome.analysis.impacts.find(
          (impact) => impact.reasonCode === "SCENE_REQUIREMENT_ALREADY_PRESENT",
        )?.explanation;
        await tracker.advance(jobId, "completed", {
          message: `Nothing to change. ${reason ?? outcome.explanation}`,
          changeRequestId: outcome.changeRequest.id,
        });
        return { kind: "COMPLETED" };
      }
    }
  };
};

/** APPLY_PROPOSAL: awaiting_approval → applying → verifying → completed. */
export const createApplyProposalJobHandler = (dependencies: {
  readonly tracker: JobTracker;
  readonly apply: ApplyApprovedProposal;
  readonly verify: VerifyAppliedProposal;
}): JobHandler => {
  const { tracker, apply, verify } = dependencies;

  return async (envelope) => {
    const parsed = applyProposalJobPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return malformed(envelope, describeIssue(parsed.error));
    const payload = parsed.data;
    const { jobId } = payload;

    const run = await tracker.get(jobId);
    if (run === null) return { kind: "FAILED", reason: `Job ${jobId} was never started.` };
    if (isTerminalStage(run.stage)) return { kind: "COMPLETED" };
    if (
      run.stage !== "awaiting_approval" &&
      run.stage !== "applying" &&
      run.stage !== "verifying"
    ) {
      const reason = `Job ${jobId} is at ${run.stage}; only a job awaiting approval can be applied.`;
      await tracker.fail(jobId, reason);
      return { kind: "FAILED", reason };
    }

    if (run.stage === "awaiting_approval") {
      await tracker.advance(jobId, "applying", { proposalId: payload.proposalId });
    }

    // Redelivered at `verifying`: the apply already committed; do not repeat it.
    if ((await tracker.get(jobId))?.stage === "applying") {
      const applied = await apply({
        productionId: envelope.productionId,
        proposalId: payload.proposalId,
        approvalId: payload.approvalId,
        expectedProductionVersion: payload.expectedProductionVersion,
        idempotencyKey: payload.idempotencyKey,
        ...(payload.appliedBy === undefined ? {} : { appliedBy: payload.appliedBy }),
        correlationId: envelope.correlationId,
      });
      if (!applied.ok) {
        await tracker.fail(jobId, `${applied.error.code}: ${applied.error.message}`);
        return failed(applied.error);
      }
      await tracker.advance(jobId, "verifying", {
        message: applied.value.replayed
          ? `Proposal ${payload.proposalId} was already applied; verifying.`
          : `Proposal ${payload.proposalId} applied as version ${applied.value.productionVersion}.`,
      });
    }

    return verifyAndFinish(tracker, verify, jobId, envelope, payload.proposalId);
  };
};

/** VERIFY_PROPOSAL: re-runs verification for a job at `verifying`. */
export const createVerifyProposalJobHandler = (dependencies: {
  readonly tracker: JobTracker;
  readonly verify: VerifyAppliedProposal;
}): JobHandler => {
  const { tracker, verify } = dependencies;

  return async (envelope) => {
    const parsed = verifyProposalJobPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return malformed(envelope, describeIssue(parsed.error));
    const { jobId, proposalId } = parsed.data;

    const run = await tracker.get(jobId);
    if (run === null) return { kind: "FAILED", reason: `Job ${jobId} was never started.` };
    if (isTerminalStage(run.stage)) return { kind: "COMPLETED" };
    if (run.stage !== "verifying") {
      const reason = `Job ${jobId} is at ${run.stage}; only an applied job can be verified.`;
      await tracker.fail(jobId, reason);
      return { kind: "FAILED", reason };
    }
    return verifyAndFinish(tracker, verify, jobId, envelope, proposalId);
  };
};

const verifyAndFinish = async (
  tracker: JobTracker,
  verify: VerifyAppliedProposal,
  jobId: EntityId,
  envelope: JobEnvelope,
  proposalId: EntityId,
): Promise<JobHandlerOutcome> => {
  const verified = await verify({
    productionId: envelope.productionId,
    proposalId,
    correlationId: envelope.correlationId,
  });
  if (!verified.ok) {
    await tracker.fail(jobId, `${verified.error.code}: ${verified.error.message}`);
    return failed(verified.error);
  }
  if (!verified.value.success) {
    const failing = verified.value.checks.filter((check) => !check.passed);
    const reason = `Verification failed: ${failing.map((check) => check.name).join(", ")}.`;
    await tracker.fail(jobId, reason);
    return { kind: "FAILED", reason };
  }
  await tracker.advance(jobId, "completed", {
    message: `Proposal ${proposalId} applied and verified.`,
  });
  return { kind: "COMPLETED" };
};

/** The one field every job payload shares. */
const jobIdPayloadSchema = z.looseObject({ jobId: z.string().min(1) });

/**
 * Connects queue transitions to the tracker: a retry is announced on the
 * run's current stage, and a queue-level failure (attempts exhausted, no
 * handler, a handler verdict the handler did not record itself) fails the
 * run. Returns the unsubscribe function.
 */
export const bindQueueToJobTracker = (queue: QueuePort, tracker: JobTracker): (() => void) =>
  queue.onTransition((transition) => {
    if (transition.to !== "QUEUED" && transition.to !== "FAILED") return;
    if (transition.from !== "RUNNING") return;
    void (async () => {
      const record = await queue.getJob(transition.jobId);
      const payload = jobIdPayloadSchema.safeParse(record?.job.payload);
      if (!payload.success) return;
      const run = await tracker.get(payload.data.jobId);
      if (run === null || isTerminalStage(run.stage)) return;
      if (transition.to === "QUEUED") {
        await tracker.note(
          run.id,
          `Retrying (attempt ${transition.attempt}): ${transition.reason ?? "transient failure"}`,
        );
      } else {
        await tracker.fail(run.id, transition.reason ?? "The job could not be delivered.");
      }
    })();
  });
