import type { AgentJobEvent, JobRun, JobStage } from "@pca/contracts";

/**
 * DESIGN.md §6 compact progress timeline, derived purely from a `JobRun`'s
 * `history` (TASK-403's stage machine): the same record the REST API and
 * the WebSocket gateway agree is the source of truth (ARCHITECTURE.md §11).
 *
 * A stage is `done` once its own `COMPLETED` event exists in `history`,
 * `active` while it is the run's current stage and not yet done, and
 * otherwise `pending` — including a stage the run's actual path skipped
 * (e.g. a change already resolved skips `resolving`; a NOTHING_TO_DO
 * outcome jumps `analyzing` straight to `completed`). A skipped stage stays
 * `pending` rather than `done`: the timeline shows what happened, not what
 * the fixed stage order implies should have.
 *
 * A run at `failed` shows only the stage that failed and its recovery
 * message (DESIGN.md §6), not the full list.
 */

export type ProgressStepStatus = "done" | "active" | "pending";

export type ProgressStep = {
  readonly stage: JobStage;
  readonly label: string;
  readonly status: ProgressStepStatus;
};

export type JobProgress =
  | { readonly kind: "steps"; readonly steps: readonly ProgressStep[] }
  | {
      readonly kind: "failed";
      readonly stage: JobStage;
      readonly label: string;
      readonly message: string;
    };

/** The fixed order and label for every non-terminal stage (DESIGN.md §6). */
const TIMELINE_STAGES: ReadonlyArray<{ readonly stage: JobStage; readonly label: string }> = [
  { stage: "received", label: "Change received" },
  { stage: "resolving", label: "Entities resolved" },
  { stage: "analyzing", label: "Impact analyzed" },
  { stage: "simulating", label: "Proposal simulated" },
  { stage: "validating", label: "Constraints validated" },
  { stage: "awaiting_approval", label: "Waiting for approval" },
  { stage: "applying", label: "Applying" },
  { stage: "verifying", label: "Verifying" },
];

const labelFor = (stage: JobStage): string =>
  TIMELINE_STAGES.find((entry) => entry.stage === stage)?.label ?? stage;

const lastFailure = (history: readonly AgentJobEvent[]): AgentJobEvent | undefined =>
  [...history].reverse().find((entry) => entry.status === "FAILED");

export const buildJobProgress = (job: JobRun | null): JobProgress | null => {
  if (job === null) return null;

  if (job.stage === "failed") {
    const failure = lastFailure(job.history);
    const stage = failure?.stage ?? job.stage;
    return {
      kind: "failed",
      stage,
      label: labelFor(stage),
      message: job.message ?? failure?.message ?? "The job failed.",
    };
  }

  const doneStages = new Set(
    job.history.filter((entry) => entry.status === "COMPLETED").map((entry) => entry.stage),
  );
  const steps: ProgressStep[] = TIMELINE_STAGES.map(({ stage, label }) => {
    const status: ProgressStepStatus = doneStages.has(stage)
      ? "done"
      : job.stage === stage
        ? "active"
        : "pending";
    return { stage, label, status };
  });
  return { kind: "steps", steps };
};
