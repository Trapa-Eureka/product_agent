import type { JobRun, JobStage } from "@pca/contracts";

import type { Logger } from "../ports";
import type { JobTracker } from "./job-tracker";

/**
 * Startup reconciliation (TASK-923, AUD-009).
 *
 * Runs outlive the process when the store is durable, but the in-process
 * queue's jobs do not: a run that was `analyzing` or `applying` when the
 * server stopped has no worker coming back for it. Left alone it would say
 * "in progress" forever. So at startup every unfinished run that is not
 * waiting on a human is failed with a reason that says what happened and
 * what to do; the two stages that *are* waiting on a human — `resolving`
 * (an interpretation to choose) and `awaiting_approval` (a decision to
 * make) — are kept, because the next request continues them. A run at
 * `applying` gets a sharper message: the apply is idempotent and may have
 * committed, so the proposal's status is the thing to check first.
 */

/** Stages where the next step is a person's, not a worker's. */
const WAITING_ON_HUMAN: readonly JobStage[] = ["resolving", "awaiting_approval"];

export const INTERRUPTED_REASON =
  "The server restarted before this job finished. Submit the change again.";
export const INTERRUPTED_WHILE_APPLYING_REASON =
  "The server restarted while applying this proposal. Check the proposal's status before retrying: the apply may already have committed.";

export type ReconcileOutcome = {
  readonly failed: readonly JobRun[];
  readonly kept: readonly JobRun[];
};

export const reconcileInterruptedRuns = async (dependencies: {
  readonly tracker: JobTracker;
  readonly repository: { listUnfinished(): Promise<JobRun[]> };
  readonly logger?: Logger;
}): Promise<ReconcileOutcome> => {
  const { tracker, repository, logger } = dependencies;
  const failed: JobRun[] = [];
  const kept: JobRun[] = [];
  for (const run of await repository.listUnfinished()) {
    if (WAITING_ON_HUMAN.includes(run.stage)) {
      kept.push(run);
      continue;
    }
    const reason =
      run.stage === "applying" ? INTERRUPTED_WHILE_APPLYING_REASON : INTERRUPTED_REASON;
    failed.push(await tracker.fail(run.id, reason));
    logger?.log("warn", "job_interrupted_by_restart", {
      jobId: run.id,
      productionId: run.productionId,
      stage: run.stage,
      correlationId: run.correlationId,
    });
  }
  if (failed.length > 0 || kept.length > 0) {
    logger?.log("info", "job_runs_reconciled", { failed: failed.length, kept: kept.length });
  }
  return { failed, kept };
};
