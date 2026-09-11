import type {
  AgentJobEvent,
  CandidateComparison,
  InterpretationOption,
  IsoDateTime,
  JobRun,
  JobStage,
  JobType,
  ProposalExplanation,
} from "@pca/contracts";

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

/**
 * The happy path in order (TASK-905). A redelivered job re-runs its
 * orchestration from the top, whose progress callbacks name stages the run
 * may already have passed; those are answered "already there", not with a
 * backward move the graph rightly refuses. `failed` sits outside the line.
 */
const JOB_STAGE_ORDER: readonly JobStage[] = [
  "received",
  "resolving",
  "analyzing",
  "simulating",
  "validating",
  "awaiting_approval",
  "applying",
  "verifying",
  "completed",
];

/** True when a run at `current` has already reached or passed `target`. */
export const isAtOrBeyond = (current: JobStage, target: JobStage): boolean =>
  current === "failed" || JOB_STAGE_ORDER.indexOf(current) >= JOB_STAGE_ORDER.indexOf(target);

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
  readonly requestedBy?: string;
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
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    history: [started],
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { run, events: [started] };
};

/**
 * What a move expects the run to be at the moment of writing (TASK-919).
 * Checked inside the atomic update, so a decision or apply that continues a
 * job cannot land on a run that meanwhile moved on or belongs to another
 * proposal: the whole move is a compare-and-set.
 */
export type JobExpectation = {
  readonly stage?: JobStage;
  readonly proposalId?: string;
};

export class JobBindingError extends Error {
  readonly code = "JOB_MISMATCH";

  constructor(
    readonly jobId: string,
    readonly detail: string,
  ) {
    super(`Job ${jobId} ${detail}`);
    this.name = "JobBindingError";
  }
}

/** Throws `JobBindingError` when the run is not what the caller expects. */
export const assertJobExpectation = (run: JobRun, expect: JobExpectation): void => {
  if (expect.stage !== undefined && run.stage !== expect.stage) {
    throw new JobBindingError(run.id, `is at ${run.stage}, not ${expect.stage}.`);
  }
  if (expect.proposalId !== undefined && run.proposalId !== expect.proposalId) {
    throw new JobBindingError(
      run.id,
      run.proposalId === undefined
        ? "has no proposal yet."
        : `belongs to proposal ${run.proposalId}, not ${expect.proposalId}.`,
    );
  }
};

export type AdvanceOptions = {
  readonly message?: string;
  readonly changeRequestId?: string;
  readonly proposalId?: string;
  /** Refuse the move unless the run matches, checked atomically with the write (TASK-919). */
  readonly expect?: JobExpectation;
  /** The DESIGN.md §4 proposal card (TASK-504), set on the move into `awaiting_approval`. */
  readonly explanation?: ProposalExplanation;
  /** The ranked/rejected shoot days behind a scheduling proposal (TASK-504). */
  readonly candidateComparison?: CandidateComparison;
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
  if (options.expect !== undefined) assertJobExpectation(run, options.expect);
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
      ...(options.explanation === undefined ? {} : { explanation: options.explanation }),
      ...(options.candidateComparison === undefined
        ? {}
        : { candidateComparison: options.candidateComparison }),
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
 *
 * `options` is how a `resolving` run carries the interpretations a sentence
 * could mean (TASK-502); omit it for every other kind of note (a retry
 * reason has none).
 */
export const noteJobRun = (
  run: JobRun,
  message: string,
  now: IsoDateTime,
  options?: readonly InterpretationOption[],
): StageMove => {
  if (isTerminalStage(run.stage)) throw new JobStageError(run.id, run.stage, run.stage);
  const noted = event(run, run.stage, "STARTED", now, message);
  return {
    run: {
      ...run,
      message,
      ...(options === undefined ? {} : { options: [...options] }),
      history: [...run.history, noted],
      updatedAt: now,
    },
    events: [noted],
  };
};
