import type { EntityId, JobRun, JobStage, JobType, ToolError } from "@pca/contracts";

/**
 * Job binding (TASK-919, SEC-008 / AUD-012).
 *
 * A decision, an apply, or a resumed change names a job to continue. The
 * job must be the one that produced that exact proposal, of the expected
 * type, at a stage where continuing makes sense — and a resumed change must
 * come from the principal who started it. Anything else is answered before
 * either the job or the proposal is touched. The atomic move itself
 * re-checks the same expectation (`AdvanceOptions.expect`), so the answer
 * here is fast and informative and the write is still a compare-and-set.
 */

export type JobBinding = {
  readonly productionId: EntityId;
  readonly type?: JobType;
  readonly proposalId?: EntityId;
  /** Stages at which continuing is allowed. */
  readonly stages?: readonly JobStage[];
  /** The principal who must own the run; checked only when the run records one. */
  readonly requestedBy?: string;
};

/** Why `run` cannot be continued as `binding` asks, or `null` when it can. */
export const describeJobMismatch = (run: JobRun | null, binding: JobBinding): ToolError | null => {
  if (run === null || run.productionId !== binding.productionId) {
    return {
      code: "ENTITY_NOT_FOUND",
      message: `Job ${run?.id ?? "(unknown)"} does not exist in production ${binding.productionId}.`,
      nextStep: "List the production's jobs and use one of them, or omit jobId.",
    };
  }
  if (binding.type !== undefined && run.type !== binding.type) {
    return {
      code: "JOB_MISMATCH",
      message: `Job ${run.id} is a ${run.type} job, not ${binding.type}.`,
      expected: binding.type,
      actual: run.type,
      nextStep: "Name the job that produced this proposal.",
    };
  }
  if (binding.proposalId !== undefined && run.proposalId !== binding.proposalId) {
    return {
      code: "JOB_MISMATCH",
      message:
        run.proposalId === undefined
          ? `Job ${run.id} has not produced a proposal.`
          : `Job ${run.id} belongs to proposal ${run.proposalId}, not ${binding.proposalId}.`,
      expected: binding.proposalId,
      ...(run.proposalId === undefined ? {} : { actual: run.proposalId }),
      nextStep: "Name the job that produced this proposal, or omit jobId.",
    };
  }
  if (binding.stages !== undefined && !binding.stages.includes(run.stage)) {
    return {
      code: "JOB_MISMATCH",
      message: `Job ${run.id} is at ${run.stage}; this action continues a job at ${binding.stages.join(" or ")}.`,
      expected: binding.stages.join("|"),
      actual: run.stage,
      nextStep: "Read the job and act on its current stage.",
    };
  }
  if (
    binding.requestedBy !== undefined &&
    run.requestedBy !== undefined &&
    run.requestedBy !== binding.requestedBy
  ) {
    return {
      code: "TOOL_UNAUTHORIZED",
      message: `Job ${run.id} was started by ${run.requestedBy}; only they may resume it.`,
      actual: binding.requestedBy,
      nextStep: "Start a new job with your own change.",
    };
  }
  return null;
};
