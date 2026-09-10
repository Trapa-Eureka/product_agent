import type { EntityId, JobRun } from "@pca/contracts";

/**
 * Where job runs live (TASK-403).
 *
 * A job run is operational state: the canonical answer to "where is my
 * change?" that a reconnecting client reads over REST. The in-process queue
 * keeps its runs in memory, because its jobs do not outlive the process
 * either; a durable queue would pair with a durable run store.
 */
export interface JobRunRepository {
  save(run: JobRun): Promise<void>;
  findById(jobId: EntityId): Promise<JobRun | null>;
  /** Newest first. */
  listByProduction(productionId: EntityId): Promise<JobRun[]>;
}
