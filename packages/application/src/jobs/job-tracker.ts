import type {
  AgentJobEvent,
  EntityId,
  InterpretationOption,
  JobRun,
  JobStage,
  JobType,
} from "@pca/contracts";

import type { Clock, IdFactory, JobRunRepository } from "../ports";
import {
  type AdvanceOptions,
  type StageMove,
  advanceJobRun,
  failJobRun,
  noteJobRun,
  startJobRun,
} from "./stage-machine";

/**
 * The job tracker owns job runs: it applies the stage machine, persists the
 * result, and publishes the events. Handlers and the queue binder talk to
 * this, never to the repository directly, so every published event is one
 * the canonical record also holds.
 */

export type JobEventListener = (event: AgentJobEvent) => void;

export type StartJobInput = {
  readonly productionId: EntityId;
  readonly correlationId: string;
  readonly type: JobType;
  readonly message?: string;
  readonly changeRequestId?: string;
  readonly proposalId?: string;
  /** The verified principal starting the job (TASK-919). */
  readonly requestedBy?: string;
};

export interface JobTracker {
  start(input: StartJobInput): Promise<JobRun>;
  advance(
    jobId: EntityId,
    to: Exclude<JobStage, "failed">,
    options?: AdvanceOptions,
  ): Promise<JobRun>;
  fail(jobId: EntityId, message: string): Promise<JobRun>;
  note(
    jobId: EntityId,
    message: string,
    options?: readonly InterpretationOption[],
  ): Promise<JobRun>;
  get(jobId: EntityId): Promise<JobRun | null>;
  listByProduction(productionId: EntityId): Promise<JobRun[]>;
  /** Every run not yet completed or failed, across productions (TASK-931 readiness). */
  listUnfinished(): Promise<JobRun[]>;
  onEvent(listener: JobEventListener): () => void;
}

export class UnknownJobError extends Error {
  readonly code = "ENTITY_NOT_FOUND";

  constructor(readonly jobId: string) {
    super(`Job ${jobId} does not exist. Start it before advancing it.`);
    this.name = "UnknownJobError";
  }
}

export const createJobTracker = (dependencies: {
  readonly repository: JobRunRepository;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): JobTracker => {
  const { repository, clock, ids } = dependencies;
  const listeners = new Set<JobEventListener>();

  const publish = (events: readonly AgentJobEvent[]): void => {
    for (const event of events) {
      for (const listener of listeners) listener(event);
    }
  };

  /**
   * Every move is one atomic `repository.update` (TASK-905, code review #6 /
   * AUD-013): the stage machine runs against the run as it is at the moment
   * of writing, never against a copy loaded earlier, so a retry `note` from
   * the queue binder and an `advance` from the handler cannot overwrite each
   * other — and only what actually landed is published.
   */
  const commit = async (jobId: EntityId, move: (run: JobRun) => StageMove): Promise<JobRun> => {
    const committed = await repository.update(jobId, (run) => {
      const next = move(run);
      return { run: next.run, result: next };
    });
    if (committed === null) throw new UnknownJobError(jobId);
    publish(committed.events);
    return committed.run;
  };

  return {
    start: async (input) => {
      const started = startJobRun({
        id: ids.next("JOB"),
        productionId: input.productionId,
        correlationId: input.correlationId,
        type: input.type,
        now: clock.now(),
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.changeRequestId === undefined ? {} : { changeRequestId: input.changeRequestId }),
        ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      });
      await repository.save(started.run);
      publish(started.events);
      return started.run;
    },
    advance: (jobId, to, options = {}) =>
      commit(jobId, (run) => advanceJobRun(run, to, clock.now(), options)),
    fail: (jobId, message) => commit(jobId, (run) => failJobRun(run, message, clock.now())),
    note: (jobId, message, options) =>
      commit(jobId, (run) => noteJobRun(run, message, clock.now(), options)),
    get: (jobId) => repository.findById(jobId),
    listByProduction: (productionId) => repository.listByProduction(productionId),
    listUnfinished: () => repository.listUnfinished(),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
