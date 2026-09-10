import type { AgentJobEvent, EntityId, JobRun, JobStage, JobType } from "@pca/contracts";

import type { Clock, IdFactory, JobRunRepository } from "../ports";
import {
  type AdvanceOptions,
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
};

export interface JobTracker {
  start(input: StartJobInput): Promise<JobRun>;
  advance(
    jobId: EntityId,
    to: Exclude<JobStage, "failed">,
    options?: AdvanceOptions,
  ): Promise<JobRun>;
  fail(jobId: EntityId, message: string): Promise<JobRun>;
  note(jobId: EntityId, message: string): Promise<JobRun>;
  get(jobId: EntityId): Promise<JobRun | null>;
  listByProduction(productionId: EntityId): Promise<JobRun[]>;
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

  const load = async (jobId: EntityId): Promise<JobRun> => {
    const run = await repository.findById(jobId);
    if (run === null) throw new UnknownJobError(jobId);
    return run;
  };

  const commit = async (move: { run: JobRun; events: AgentJobEvent[] }): Promise<JobRun> => {
    await repository.save(move.run);
    publish(move.events);
    return move.run;
  };

  return {
    start: (input) =>
      commit(
        startJobRun({
          id: ids.next("JOB"),
          productionId: input.productionId,
          correlationId: input.correlationId,
          type: input.type,
          now: clock.now(),
          ...(input.message === undefined ? {} : { message: input.message }),
          ...(input.changeRequestId === undefined
            ? {}
            : { changeRequestId: input.changeRequestId }),
          ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        }),
      ),
    advance: async (jobId, to, options = {}) =>
      commit(advanceJobRun(await load(jobId), to, clock.now(), options)),
    fail: async (jobId, message) => commit(failJobRun(await load(jobId), message, clock.now())),
    note: async (jobId, message) => commit(noteJobRun(await load(jobId), message, clock.now())),
    get: (jobId) => repository.findById(jobId),
    listByProduction: (productionId) => repository.listByProduction(productionId),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
