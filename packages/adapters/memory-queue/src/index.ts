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
};

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createMemoryQueue = (options: MemoryQueueOptions = {}): MemoryQueue => {
  const policy: QueuePolicy = { ...DEFAULT_QUEUE_POLICY, ...options.policy };
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdFactory;
  const scheduler = options.scheduler ?? timerScheduler;

  const records = new Map<EntityId, MutableRecord>();
  const jobIdByKey = new Map<string, EntityId>();
  const handlers = new Map<JobType, JobHandler>();
  const listeners = new Set<(transition: JobTransition) => void>();
  const deadLetters: EntityId[] = [];

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
  ): void => {
    record.state = to;
    record.updatedAt = clock.now();
    if (reason !== undefined) record.lastError = reason;
    const event: JobTransition = {
      jobId: record.job.id,
      type: record.job.type,
      productionId: record.job.productionId,
      correlationId: record.job.correlationId,
      from,
      to,
      attempt: record.job.attempt,
      ...(reason === undefined ? {} : { reason }),
      occurredAt: record.updatedAt,
    };
    for (const listener of listeners) listener(event);
  };

  const scheduleLoop = (delayMs: number): void => {
    scheduler.schedule(() => {
      void runLoop();
    }, delayMs);
  };

  const requeue = (record: MutableRecord, reason: string): void => {
    record.job = { ...record.job, attempt: record.job.attempt + 1 };
    transition(record, "QUEUED", reason);
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
          requeue(record, outcome.reason);
          return;
        }
        record.deadLettered = true;
        deadLetters.push(record.job.id);
        transition(
          record,
          "FAILED",
          `Gave up after ${policy.maxAttempts} attempts. Last reason: ${outcome.reason}`,
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
      outcome = { kind: "RETRY", reason: errorMessage(error) };
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
      const existingId = jobIdByKey.get(parsed.data.idempotencyKey);
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
      jobIdByKey.set(record.job.idempotencyKey, record.job.id);
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
export const createMemoryJobRunRepository = (): JobRunRepository => {
  const runs = new Map<EntityId, JobRun>();
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- port methods are async; nothing here awaits
    async save(run) {
      runs.set(run.id, structuredClone(run));
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
  };
};
