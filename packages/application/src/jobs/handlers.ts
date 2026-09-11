import { z } from "zod";

import type {
  CandidateComparison,
  EntityId,
  JobEnvelope,
  RankedCandidate,
  ScheduleCandidate,
  ToolError,
} from "@pca/contracts";
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
import { isAtOrBeyond, isTerminalStage } from "./stage-machine";

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

/**
 * DESIGN.md §2 "Proposed Plan" candidate comparison (TASK-504): the ranked
 * and rejected shoot days `runChangeAgent` already computed, merged by
 * shoot day and sorted by rank. `undefined` for a change that never
 * generated candidates (not a scheduling move).
 */
const buildCandidateComparison = (
  candidates: readonly ScheduleCandidate[],
  ranked: readonly RankedCandidate[],
  rejected: CandidateComparison["rejected"],
): CandidateComparison | undefined => {
  if (ranked.length === 0) return undefined;
  const byShootDayId = new Map(candidates.map((candidate) => [candidate.shootDayId, candidate]));
  const merged = ranked
    .map((entry) => {
      const candidate = byShootDayId.get(entry.shootDayId);
      return candidate === undefined
        ? null
        : { ...candidate, rank: entry.rank, reason: entry.reason };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.rank - right.rank);
  return merged.length === 0 ? undefined : { ranked: merged, rejected: [...rejected] };
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

    // A sentence still to be interpreted waits at `resolving` (the user may
    // be asked); a resolved change enters `analyzing` from the loop's first
    // progress callback below, which is also where the change request it
    // just recorded gets attached to the run.
    if (run.stage === "received" && change === undefined) {
      await tracker.advance(jobId, "resolving");
    }

    // TASK-905 (code review #5 / AUD-013): a redelivered job re-runs the
    // whole orchestration. Its progress callbacks are monotonic — a stage the
    // run already reached or passed is left alone rather than moved back to,
    // which used to throw on every retry at `simulating`/`validating` — and
    // the change request the first attempt recorded is reused rather than
    // submitted again.
    const result = await runChangeAgent({
      productionId: envelope.productionId,
      text,
      ...(change === undefined ? {} : { change }),
      ...(run.changeRequestId === undefined ? {} : { changeRequestId: run.changeRequestId }),
      requestedBy,
      correlationId: envelope.correlationId,
      progress: async (stage, details) => {
        const current = await tracker.get(jobId);
        if (current === null || isAtOrBeyond(current.stage, stage)) return;
        await tracker.advance(jobId, stage, {
          ...(details?.changeRequestId === undefined
            ? {}
            : { changeRequestId: details.changeRequestId }),
        });
      },
    });

    if (!result.ok) {
      await tracker.fail(jobId, `${result.error.code}: ${result.error.message}`);
      return failed(result.error);
    }

    const outcome = result.value;
    switch (outcome.kind) {
      case "NEEDS_RESOLUTION":
        await tracker.note(jobId, outcome.question, outcome.options);
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
        const candidateComparison = buildCandidateComparison(
          outcome.candidates,
          outcome.ranked,
          outcome.rejected,
        );
        await tracker.advance(jobId, "awaiting_approval", {
          message: outcome.explanation.headline,
          changeRequestId: outcome.changeRequest.id,
          proposalId: proposal.id,
          explanation: outcome.explanation,
          ...(candidateComparison === undefined ? {} : { candidateComparison }),
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
    // TASK-919 (SEC-008 / AUD-012): a payload naming another proposal must
    // not advance this run — and must not fail it either, since the run is
    // someone else's timeline. The queue job alone fails.
    if (run.proposalId !== undefined && run.proposalId !== payload.proposalId) {
      return {
        kind: "FAILED",
        reason: `Job ${jobId} belongs to proposal ${run.proposalId}, not ${payload.proposalId}; the run was left untouched.`,
      };
    }
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
      // Compare-and-set: the move lands only if the run is still awaiting
      // approval for this very proposal at the moment of writing.
      // A run that recorded its proposal is held to it; one that has none
      // yet (a job started by hand) records this one.
      await tracker.advance(jobId, "applying", {
        proposalId: payload.proposalId,
        expect: {
          stage: "awaiting_approval",
          ...(run.proposalId === undefined ? {} : { proposalId: payload.proposalId }),
        },
      });
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
    if (run.proposalId !== undefined && run.proposalId !== proposalId) {
      return {
        kind: "FAILED",
        reason: `Job ${jobId} belongs to proposal ${run.proposalId}, not ${proposalId}; the run was left untouched.`,
      };
    }
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
