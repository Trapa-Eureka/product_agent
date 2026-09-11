import type { EntityId, JobRun } from "@pca/contracts";

/**
 * Where job runs live (TASK-403).
 *
 * A job run is operational state: the canonical answer to "where is my
 * change?" that a reconnecting client reads over REST. With the in-process
 * queue and the file or memory store, runs live in memory and die with the
 * process; with `PCA_STORAGE=mongo` they live in Mongo (TASK-923), so a
 * restart keeps every run — and the runs the restart interrupted are
 * reconciled at startup (`reconcileInterruptedRuns`).
 */
/**
 * The read side of the run store, for queries (a job by ID, a production's
 * recovery snapshot) that must not be handed write access to invent one.
 */
export type JobRunReader = Pick<JobRunRepository, "findById" | "listByProduction">;

export interface JobRunRepository {
  save(run: JobRun): Promise<void>;
  findById(jobId: EntityId): Promise<JobRun | null>;
  /** Newest first. */
  listByProduction(productionId: EntityId): Promise<JobRun[]>;
  /** Every run not yet at `completed` or `failed`, across productions (TASK-923 startup reconciliation). */
  listUnfinished(): Promise<JobRun[]>;
  /**
   * Loads, transforms, and stores one run as a single atomic step (TASK-905,
   * code review #6 / AUD-013). Two updates to the same run cannot interleave:
   * the second always sees the first one's result, so an `advance` and a
   * retry `note` racing from the queue binder and the handler both land.
   * `transform` is pure and may throw (a `JobStageError`, say) — nothing is
   * written then. Returns `null` when the run does not exist. A durable
   * adapter implements this with a compare-and-set on a revision and a
   * retry; the in-memory one with a synchronous read-transform-write.
   */
  update<T>(
    jobId: EntityId,
    transform: (run: JobRun) => { readonly run: JobRun; readonly result: T },
  ): Promise<T | null>;
}
