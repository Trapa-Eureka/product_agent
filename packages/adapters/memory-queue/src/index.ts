import type { EntityId, JobEnvelope, JobRun, JobType } from "@pca/contracts";
import { jobEnvelopeSchema } from "@pca/contracts";
import type {
  Clock,
  EnqueueJobInput,
  EnqueueOutcome,
  IdFactory,
  JobHandler,
  JobHandlerOutcome,
  JobRecord,
  JobRunRepository,
  JobState,
  JobTransition,
  QueuePolicy,
  QueuePort,
  Scheduler,
} from "@pca/application";
import {
  DEFAULT_QUEUE_POLICY,
  describeFailure,
  describeFailureForUser,
  jobIdentityKey,
  randomIdFactory,
  systemClock,
  timerScheduler,
} from "@pca/application";

/**
 * In-process queue (TASK-401, ARCHITECTURE.md §10).
 *
 * The free default and the test double in one: the same object serves the
 * published package at runtime and the queue contract suite. It delivers
 * jobs one at a time in enqueue order, retries through an injected scheduler
 * so tests can hold time still, and keeps every record in memory.
 *
 * Single process only. Two processes sharing work need the SQS adapter
 * (TASK-402, deferred).
 */

export type MemoryQueueOptions = {
  readonly policy?: Partial<QueuePolicy>;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly scheduler?: Scheduler;
  /**
   * Finished jobs kept in memory (TASK-917). Past this many records, the
   * oldest COMPLETED/FAILED ones are forgotten — with their idempotency
   * keys, so a very old key may enqueue again. Default 1000.
   */
  readonly maxRetainedJobs?: number;
};

export const DEFAULT_MAX_RETAINED_JOBS = 1000;

export type MemoryQueue = QueuePort & {
  /**
   * Puts a job back on the ready list as an at-least-once transport would,
   * whatever the queue believes its state is. A job that is not `QUEUED` is
   * skipped at delivery, so a duplicate delivery never runs a handler twice.
   */
  redeliver(jobId: EntityId): void;
  listJobs(): Promise<JobRecord[]>;
};

type MutableRecord = {
  job: JobEnvelope;
  state: JobState;
  lastError?: string;
  deadLettered: boolean;
  enqueuedAt: string;
  updatedAt: string;
};

const enqueueInputSchema = jobEnvelopeSchema.omit({ id: true, attempt: true });

const snapshot = (record: MutableRecord): JobRecord => ({
  job: { ...record.job },
  state: record.state,
  ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  deadLettered: record.deadLettered,
  enqueuedAt: record.enqueuedAt,
  updatedAt: record.updatedAt,
});

export const createMemoryQueue = (options: MemoryQueueOptions = {}): MemoryQueue => {
  const policy: QueuePolicy = { ...DEFAULT_QUEUE_POLICY, ...options.policy };
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdFactory;
  const scheduler = options.scheduler ?? timerScheduler;

  const maxRetained = options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS;
  const records = new Map<EntityId, MutableRecord>();
  const jobIdByKey = new Map<string, EntityId>();
  const handlers = new Map<JobType, JobHandler>();
  const listeners = new Set<(transition: JobTransition) => void>();
  const deadLetters: EntityId[] = [];

  /** Forgets the oldest finished jobs once more than `maxRetained` records are held. */
  const prune = (): void => {
    if (records.size <= maxRetained) return;
    for (const [jobId, record] of records) {
      if (records.size <= maxRetained) return;
      if (record.state !== "COMPLETED" && record.state !== "FAILED") continue;
      records.delete(jobId);
      const identity = jobIdentityKey(record.job);
      if (jobIdByKey.get(identity) === jobId) {
        jobIdByKey.delete(identity);
      }
      const dead = deadLetters.indexOf(jobId);
      if (dead !== -1) deadLetters.splice(dead, 1);
    }
  };

  /** Jobs ready to deliver, in order. */
  const ready: EntityId[] = [];
  /** Retries waiting on the scheduler, with the function that cancels the wait. */
  const waiting = new Map<EntityId, () => void>();
  let started = false;
  let loop: Promise<number> | null = null;

  const transition = (
    record: MutableRecord,
    to: JobState,
    reason?: string,
    from: JobState | null = record.state,
    userReason?: string,
  ): void => {
    record.state = to;
    record.updatedAt = clock.now();
    if (reason !== undefined) record.lastError = reason;
    if (to === "COMPLETED" || to === "FAILED") prune();
    const event: JobTransition = {
      jobId: record.job.id,
      type: record.job.type,
      productionId: record.job.productionId,
      correlationId: record.job.correlationId,
      from,
      to,
      attempt: record.job.attempt,
      ...(reason === undefined ? {} : { reason }),
      ...(reason === undefined ? {} : { userReason: userReason ?? reason }),
      occurredAt: record.updatedAt,
    };
    for (const listener of listeners) listener(event);
  };

  const scheduleLoop = (delayMs: number): void => {
    scheduler.schedule(() => {
      void runLoop();
    }, delayMs);
  };

  const requeue = (record: MutableRecord, reason: string, userReason?: string): void => {
    record.job = { ...record.job, attempt: record.job.attempt + 1 };
    transition(record, "QUEUED", reason, record.state, userReason);
    const jobId = record.job.id;
    if (!started) {
      ready.push(jobId);
      return;
    }
    const cancel = scheduler.schedule(() => {
      waiting.delete(jobId);
      ready.push(jobId);
      void runLoop();
    }, policy.retryDelayMs(record.job.attempt));
    waiting.set(jobId, cancel);
  };

  const settle = (record: MutableRecord, outcome: JobHandlerOutcome): void => {
    switch (outcome.kind) {
      case "COMPLETED":
        transition(record, "COMPLETED");
        return;
      case "FAILED":
        transition(record, "FAILED", outcome.reason);
        return;
      case "RETRY":
        if (record.job.attempt < policy.maxAttempts) {
          requeue(record, outcome.reason, outcome.userReason);
          return;
        }
        record.deadLettered = true;
        deadLetters.push(record.job.id);
        transition(
          record,
          "FAILED",
          `Gave up after ${policy.maxAttempts} attempts. Last reason: ${outcome.reason}`,
          record.state,
          `Gave up after ${policy.maxAttempts} attempts. Last reason: ${outcome.userReason ?? outcome.reason}`,
        );
    }
  };

  const deliver = async (jobId: EntityId): Promise<boolean> => {
    const record = records.get(jobId);
    // Not QUEUED means already delivered (or being delivered): a duplicate delivery is a no-op.
    if (record === undefined || record.state !== "QUEUED") return false;
    transition(record, "RUNNING");
    const handler = handlers.get(record.job.type);
    if (handler === undefined) {
      settle(record, {
        kind: "FAILED",
        reason: `No handler is registered for job type ${record.job.type}. Register one before enqueueing.`,
      });
      return true;
    }
    let outcome: JobHandlerOutcome;
    try {
      outcome = await handler({ ...record.job });
    } catch (error) {
      // The reason names the boundary that failed and the request it failed in.
      outcome = {
        kind: "RETRY",
        reason: describeFailure(error, record.job.correlationId),
        // TASK-924: the run a coordinator reads gets the fixed sentence; the raw cause stays in `reason`.
        userReason: describeFailureForUser(error, record.job.correlationId),
      };
    }
    settle(record, outcome);
    return true;
  };

  const runLoop = (): Promise<number> => {
    if (loop !== null) return loop;
    loop = (async () => {
      let deliveries = 0;
      while (ready.length > 0) {
        const jobId = ready.shift() as EntityId;
        if (await deliver(jobId)) deliveries += 1;
      }
      return deliveries;
    })().finally(() => {
      loop = null;
    });
    return loop;
  };

  /** Waiting retries become ready now; time is not a factor when draining. */
  const promoteWaiting = (): void => {
    for (const [jobId, cancel] of waiting) {
      cancel();
      ready.push(jobId);
    }
    waiting.clear();
  };

  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async enqueue(input: EnqueueJobInput): Promise<EnqueueOutcome> {
      const parsed = enqueueInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `Job is malformed at ${issue?.path.join(".") ?? "<root>"}: ${issue?.message ?? "unknown issue"}.`,
        );
      }
      // TASK-935: identity is the (productionId, type, idempotencyKey) tuple, not the bare key.
      const existingId = jobIdByKey.get(jobIdentityKey(parsed.data));
      if (existingId !== undefined) {
        return { kind: "DUPLICATE", record: snapshot(records.get(existingId) as MutableRecord) };
      }
      const now = clock.now();
      const record: MutableRecord = {
        job: { ...parsed.data, id: ids.next("JOB"), attempt: 1 },
        state: "QUEUED",
        deadLettered: false,
        enqueuedAt: now,
        updatedAt: now,
      };
      records.set(record.job.id, record);
      jobIdByKey.set(jobIdentityKey(record.job), record.job.id);
      transition(record, "QUEUED", undefined, null);
      ready.push(record.job.id);
      if (started) scheduleLoop(0);
      return { kind: "ENQUEUED", record: snapshot(record) };
    },

    register(type, handler) {
      handlers.set(type, handler);
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async getJob(jobId) {
      const record = records.get(jobId);
      return record === undefined ? null : snapshot(record);
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async listDeadLetters() {
      return deadLetters.map((jobId) => snapshot(records.get(jobId) as MutableRecord));
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async stats() {
      let queued = 0;
      let running = 0;
      for (const record of records.values()) {
        if (record.state === "QUEUED" && !waiting.has(record.job.id)) queued += 1;
        if (record.state === "RUNNING") running += 1;
      }
      return {
        queued,
        running,
        waiting: waiting.size,
        deadLettered: deadLetters.length,
        retained: records.size,
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async listJobs() {
      return [...records.values()].map(snapshot);
    },

    onTransition(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async drain() {
      let deliveries = 0;
      do {
        promoteWaiting();
        deliveries += await runLoop();
      } while (ready.length > 0 || waiting.size > 0);
      return deliveries;
    },

    start() {
      if (started) return;
      started = true;
      if (ready.length > 0) scheduleLoop(0);
    },

    stop() {
      if (!started) return;
      started = false;
      // Retries stop waiting on timers; they run at the next drain or start.
      promoteWaiting();
    },

    redeliver(jobId) {
      ready.push(jobId);
    },
  };
};

/**
 * Job runs for the in-process queue (TASK-403). They live and die with the
 * process, as its jobs do. Newest first when listed.
 */
export const DEFAULT_MAX_RUNS_PER_PRODUCTION = 500;

export type MemoryJobRunOptions = {
  /**
   * Finished runs kept per production (TASK-917). Past this many, the oldest
   * completed/failed runs are forgotten; a run still in progress never is.
   */
  readonly maxRunsPerProduction?: number;
};

export const createMemoryJobRunRepository = (
  options: MemoryJobRunOptions = {},
): JobRunRepository => {
  const runs = new Map<EntityId, JobRun>();
  const maxPerProduction = options.maxRunsPerProduction ?? DEFAULT_MAX_RUNS_PER_PRODUCTION;
  const isFinished = (run: JobRun): boolean => run.stage === "completed" || run.stage === "failed";

  const prune = (productionId: EntityId): void => {
    const finished = [...runs.values()]
      .filter((run) => run.productionId === productionId && isFinished(run))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const run of finished.slice(0, Math.max(0, finished.length - maxPerProduction))) {
      runs.delete(run.id);
    }
  };

  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async save(run) {
      runs.set(run.id, structuredClone(run));
      if (isFinished(run)) prune(run.productionId);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async findById(jobId) {
      const run = runs.get(jobId);
      return run === undefined ? null : structuredClone(run);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async listByProduction(productionId) {
      return [...runs.values()]
        .filter((run) => run.productionId === productionId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((run) => structuredClone(run));
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async listUnfinished() {
      return [...runs.values()]
        .filter((run) => !isFinished(run))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((run) => structuredClone(run));
    },
    // TASK-905: read, transform, and write with no `await` in between, so no
    // other update to this run can observe or overwrite the intermediate state.
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async update(jobId, transform) {
      const current = runs.get(jobId);
      if (current === undefined) return null;
      const { run, result } = transform(structuredClone(current));
      runs.set(jobId, structuredClone(run));
      if (isFinished(run)) prune(run.productionId);
      return result;
    },
  };
};
