import type { AgentJobEvent, IsoDateTime, JobRun, JobStage, JobType } from "@pca/contracts";

/**
 * Job stage machine (TASK-403, SPEC.md §7, DESIGN.md §6).
 *
 * Pure functions over an immutable `JobRun`. The graph below is the only
 * way a run may move, and it encodes the product's central promise: there is
 * no edge from analysis to `applying` that does not pass through
 * `awaiting_approval`, and there is no edge out of a terminal stage.
 *
 * Each move publishes events for the UI timeline: the stage being left is
 * `COMPLETED` (or `FAILED` on failure) and the stage being entered is
 * `STARTED`. The terminal stages publish a single event of their own.
 */

export const JOB_STAGE_TRANSITIONS: Readonly<Record<JobStage, readonly JobStage[]>> = {
  /** A change the user already resolved skips straight to analysis. */
  received: ["resolving", "analyzing", "failed"],
  resolving: ["analyzing", "failed"],
  /** Analysis with nothing to propose (already true, no candidate) completes here. */
  analyzing: ["simulating", "completed", "failed"],
  simulating: ["validating", "failed"],
  validating: ["awaiting_approval", "failed"],
  /** Approval leads to apply; rejection completes the run. */
  awaiting_approval: ["applying", "completed", "failed"],
  applying: ["verifying", "failed"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: [],
};

export const TERMINAL_JOB_STAGES: readonly JobStage[] = ["completed", "failed"];

export const isTerminalStage = (stage: JobStage): boolean => TERMINAL_JOB_STAGES.includes(stage);

export const canAdvance = (from: JobStage, to: JobStage): boolean =>
  JOB_STAGE_TRANSITIONS[from].includes(to);

export class JobStageError extends Error {
  readonly code = "INVALID_STAGE_TRANSITION";

  constructor(
    readonly jobId: string,
    readonly from: JobStage,
    readonly to: JobStage,
  ) {
    super(
      `Job ${jobId} cannot move from ${from} to ${to}. Allowed: ${
        JOB_STAGE_TRANSITIONS[from].length === 0
          ? "none (terminal stage)"
          : JOB_STAGE_TRANSITIONS[from].join(", ")
      }.`,
    );
    this.name = "JobStageError";
  }
}

export type StageMove = {
  readonly run: JobRun;
  readonly events: AgentJobEvent[];
};

export type StartJobRunInput = {
  readonly id: string;
  readonly productionId: string;
  readonly correlationId: string;
  readonly type: JobType;
  readonly now: IsoDateTime;
  readonly message?: string;
  readonly changeRequestId?: string;
  readonly proposalId?: string;
};

const event = (
  run: Pick<JobRun, "id" | "productionId" | "correlationId">,
  stage: JobStage,
  status: AgentJobEvent["status"],
  occurredAt: IsoDateTime,
  message?: string,
): AgentJobEvent => ({
  jobId: run.id,
  productionId: run.productionId,
  correlationId: run.correlationId,
  stage,
  status,
  ...(message === undefined ? {} : { message }),
  occurredAt,
});

/** A new run at `received`, started. */
export const startJobRun = (input: StartJobRunInput): StageMove => {
  const identity = {
    id: input.id,
    productionId: input.productionId,
    correlationId: input.correlationId,
  };
  const started = event(identity, "received", "STARTED", input.now, input.message);
  const run: JobRun = {
    ...identity,
    type: input.type,
    stage: "received",
    status: "STARTED",
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.changeRequestId === undefined ? {} : { changeRequestId: input.changeRequestId }),
    ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
    history: [started],
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { run, events: [started] };
};

export type AdvanceOptions = {
  readonly message?: string;
  readonly changeRequestId?: string;
  readonly proposalId?: string;
};

/**
 * Moves a run along an allowed edge. `failed` is not reachable here; use
 * `failJobRun`, which records which stage failed.
 */
export const advanceJobRun = (
  run: JobRun,
  to: Exclude<JobStage, "failed">,
  now: IsoDateTime,
  options: AdvanceOptions = {},
): StageMove => {
  if (!canAdvance(run.stage, to)) throw new JobStageError(run.id, run.stage, to);
  const left = event(run, run.stage, "COMPLETED", now);
  const entered =
    to === "completed"
      ? event(run, "completed", "COMPLETED", now, options.message)
      : event(run, to, "STARTED", now, options.message);
  const events = [left, entered];
  return {
    run: {
      ...run,
      stage: to,
      status: entered.status,
      ...(options.message === undefined ? {} : { message: options.message }),
      ...(options.changeRequestId === undefined
        ? {}
        : { changeRequestId: options.changeRequestId }),
      ...(options.proposalId === undefined ? {} : { proposalId: options.proposalId }),
      history: [...run.history, ...events],
      updatedAt: now,
    },
    events,
  };
};

/**
 * Ends a run in `failed`, publishing the failure against the stage that was
 * running so the UI can show "Applying failed: ..." rather than just "failed".
 */
export const failJobRun = (run: JobRun, message: string, now: IsoDateTime): StageMove => {
  if (!canAdvance(run.stage, "failed")) throw new JobStageError(run.id, run.stage, "failed");
  const failed = event(run, run.stage, "FAILED", now, message);
  return {
    run: {
      ...run,
      stage: "failed",
      status: "FAILED",
      message,
      history: [...run.history, failed],
      updatedAt: now,
    },
    events: [failed],
  };
};

/**
 * Re-announces the current stage with a message, without moving: a retry in
 * progress, or a question the run is waiting on. Terminal runs cannot be noted.
 */
export const noteJobRun = (run: JobRun, message: string, now: IsoDateTime): StageMove => {
  if (isTerminalStage(run.stage)) throw new JobStageError(run.id, run.stage, run.stage);
  const noted = event(run, run.stage, "STARTED", now, message);
  return {
    run: { ...run, message, history: [...run.history, noted], updatedAt: now },
    events: [noted],
  };
};
