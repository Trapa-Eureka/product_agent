import { z } from "zod";

import {
  correlationIdSchema,
  entityIdSchema,
  explanationSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
} from "./primitives";

/**
 * Async job and realtime contracts (SPEC.md §7, ARCHITECTURE.md §10-11).
 *
 * WebSocket events are a notification channel, not the source of truth: a client
 * that misses one re-reads canonical state over REST (ARCHITECTURE.md §11).
 */

/** The user-visible pipeline, in order. */
export const jobStageSchema = z.enum([
  "received",
  "resolving",
  "analyzing",
  "simulating",
  "validating",
  "awaiting_approval",
  "applying",
  "verifying",
  "completed",
  "failed",
]);

export const jobStatusSchema = z.enum(["STARTED", "COMPLETED", "FAILED"]);

export const agentJobEventSchema = z.strictObject({
  jobId: entityIdSchema,
  productionId: entityIdSchema,
  correlationId: correlationIdSchema,
  stage: jobStageSchema,
  status: jobStatusSchema,
  message: explanationSchema.optional(),
  occurredAt: isoDateTimeSchema,
});

export const jobTypeSchema = z.enum(["ANALYZE_CHANGE", "APPLY_PROPOSAL", "VERIFY_PROPOSAL"]);

/**
 * Queue message envelope. The same shape crosses the in-process queue and any
 * future SQS adapter, so retry and idempotency behaviour is testable without a
 * cloud account.
 */
export const jobEnvelopeSchema = z.strictObject({
  id: entityIdSchema,
  type: jobTypeSchema,
  productionId: entityIdSchema,
  correlationId: correlationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  attempt: z.int().positive(),
  payload: z.unknown(),
});

export type JobStage = z.infer<typeof jobStageSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type AgentJobEvent = z.infer<typeof agentJobEventSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
