import type { EntityId, IsoDateTime, JobEnvelope, JobType } from "@pca/contracts";

import { scopedKeyOf } from "./isolation";

/**
 * Queue port (ARCHITECTURE.md §10, TASK-401).
 *
 * Asynchronous jobs cross this port: analysis that may call a model, an apply,
 * a verification. The in-process queue and any future SQS adapter implement
 * the same contract, so retry, idempotency, and terminal failure are tested
 * once, locally, without a cloud account.
 *
 * Rules the port fixes, whatever the transport:
 *
 * - a job's identity is the tuple `(productionId, type, idempotencyKey)`
 *   (TASK-935, code review #19): a second enqueue with the same tuple is a
 *   `DUPLICATE` and never runs the handler twice, while the same key in two
 *   productions, or for two job types, is two jobs — a client-generated key
 *   in one production can never suppress another production's job;
 * - retry is bounded by `QueuePolicy.maxAttempts`; exhausting it is an
 *   explicit `FAILED` state and a dead-letter entry, not a silent drop;
 * - a handler decides between retrying and failing; an exception it throws is
 *   treated as transient and retried, so an outage is not mistaken for a bad
 *   job;
 * - every state change is observable through `onTransition`, which is what
 *   the job state machine and the WebSocket gateway listen to.
 */

export type JobState = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type JobRecord = {
  /** The envelope as last delivered; `attempt` counts deliveries so far. */
  readonly job: JobEnvelope;
  readonly state: JobState;
  readonly lastError?: string;
  /** True when the job failed by exhausting its attempts rather than by a handler verdict. */
  readonly deadLettered: boolean;
  readonly enqueuedAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
};

export type JobTransition = {
  readonly jobId: EntityId;
  readonly type: JobType;
  readonly productionId: EntityId;
  readonly correlationId: string;
  /** `null` on the first transition, when the job is created. */
  readonly from: JobState | null;
  readonly to: JobState;
  readonly attempt: number;
  /** For operators: names the boundary and the cause. */
  readonly reason?: string;
  /** For people: what a job run may show (TASK-924). Equal to `reason` unless the reason is an infrastructure fault. */
  readonly userReason?: string;
  readonly occurredAt: IsoDateTime;
};

export type QueueStats = {
  /** Ready to deliver now. */
  readonly queued: number;
  /** A handler is running it. */
  readonly running: number;
  /** Waiting on a retry timer. */
  readonly waiting: number;
  readonly deadLettered: number;
  /** Records retained in memory (TASK-917 caps them). */
  readonly retained: number;
};

export type JobHandlerOutcome =
  | { readonly kind: "COMPLETED" }
  /** Transient trouble; deliver again if attempts remain. `userReason` when `reason` must not reach a run. */
  | { readonly kind: "RETRY"; readonly reason: string; readonly userReason?: string }
  /** The job itself is wrong; do not deliver again. */
  | { readonly kind: "FAILED"; readonly reason: string };

export type JobHandler = (job: JobEnvelope) => Promise<JobHandlerOutcome>;

export type EnqueueJobInput = Omit<JobEnvelope, "id" | "attempt">;

export type EnqueueOutcome =
  | { readonly kind: "ENQUEUED"; readonly record: JobRecord }
  /** The `(productionId, type, idempotencyKey)` tuple was seen before; `record` is the existing job. */
  | { readonly kind: "DUPLICATE"; readonly record: JobRecord };

/**
 * The one string every adapter indexes a job's identity by (TASK-935). Each
 * part is escaped the way `scopedRecordKey` escapes, so a key or ID that
 * contains the separator cannot forge another tuple.
 */
export const jobIdentityKey = (
  job: Pick<JobEnvelope, "productionId" | "type" | "idempotencyKey">,
): string => scopedKeyOf(job.productionId, job.type, job.idempotencyKey);

export type QueuePolicy = {
  /** Deliveries per job, including the first. */
  readonly maxAttempts: number;
  /** Delay before delivery number `attempt` (2..maxAttempts), for a running consumer. */
  readonly retryDelayMs: (attempt: number) => number;
};

/** Three deliveries, backing off 250 ms, 500 ms. */
export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  maxAttempts: 3,
  retryDelayMs: (attempt) => 250 * 2 ** (attempt - 2),
};

export interface QueuePort {
  enqueue(input: EnqueueJobInput): Promise<EnqueueOutcome>;
  /** One handler per job type; a job with no handler fails explicitly. */
  register(type: JobType, handler: JobHandler): void;
  getJob(jobId: EntityId): Promise<JobRecord | null>;
  /** Jobs that failed by exhausting their attempts, oldest first. */
  listDeadLetters(): Promise<JobRecord[]>;
  /** Depth and saturation counters for readiness (TASK-931); cheap, no scan of payloads. */
  stats(): Promise<QueueStats>;
  onTransition(listener: (transition: JobTransition) => void): () => void;
  /**
   * Deliver every runnable job, retries included, until nothing is runnable.
   * The deterministic path for tests and CLIs. Returns the number of deliveries.
   */
  drain(): Promise<number>;
  /** Deliver in the background as jobs arrive, honouring retry delays. */
  start(): void;
  stop(): void;
}

/**
 * Timers are a port too. A running queue schedules its retries through this,
 * so a test can hold time still and release it one delay at a time.
 */
export interface Scheduler {
  /** Runs `task` after `delayMs`; the returned function cancels it. */
  schedule(task: () => void, delayMs: number): () => void;
}

/** `setTimeout`, unreferenced so a queue never keeps a process alive on its own. */
export const timerScheduler: Scheduler = {
  schedule: (task, delayMs) => {
    const handle = setTimeout(task, delayMs);
    handle.unref();
    return () => clearTimeout(handle);
  },
};
