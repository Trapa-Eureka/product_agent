import { z } from "zod";

import { typedChangeSchema } from "./change";
import { proposalExplanationSchema } from "./explanation";
import { rejectedScheduleDaySchema } from "./mcp";
import { interpretationOptionSchema } from "./model";
import {
  correlationIdSchema,
  entityIdSchema,
  explanationSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  localDateSchema,
  productionVersionSchema,
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

/** A candidate shoot day, ranked, for the DESIGN.md §2 "Proposed Plan" comparison (TASK-504). */
export const rankedScheduleCandidateSchema = z.strictObject({
  shootDayId: entityIdSchema,
  date: localDateSchema,
  sceneIds: z.array(entityIdSchema).min(1),
  /** Things worth knowing that do not invalidate the day, e.g. a cast member already booked. */
  warnings: z.array(explanationSchema),
  rank: z.int().positive(),
  reason: explanationSchema,
});

/** Every day the candidate generator considered for a scheduling change, ranked and rejected. */
export const candidateComparisonSchema = z.strictObject({
  ranked: z.array(rankedScheduleCandidateSchema).min(1),
  rejected: z.array(rejectedScheduleDaySchema),
});

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

/**
 * The canonical record of one change's journey through the pipeline
 * (TASK-403). WebSocket events are derived from it, never the other way
 * round: a client that missed events re-reads this over REST.
 *
 * `stage` is where the job is; `status` is how that stage stands
 * (`STARTED` while in progress or waiting, `COMPLETED`/`FAILED` when it is
 * terminal). `history` is every event ever published for the job.
 *
 * `options` is set only while `stage` is `resolving` (TASK-502): the
 * interpretations the sentence could mean, so a client can render the
 * choice and resume the same job with the one the user picks. Like
 * `message`, it is not cleared on the next transition; a client reads it
 * only when `stage === "resolving"`.
 *
 * `explanation` and `candidateComparison` are set once a proposal exists
 * (TASK-504): the DESIGN.md §4 proposal card `runChangeAgent` already built
 * (headline, `+`/`!` effects, operations), and, for a scheduling change, the
 * ranked and rejected shoot days the candidate generator considered. Like
 * `options`, they reach a client only through this record — the agent
 * computed them once, synchronously, and nothing recomputes them later.
 */
export const jobRunSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  correlationId: correlationIdSchema,
  type: jobTypeSchema,
  stage: jobStageSchema,
  status: jobStatusSchema,
  message: explanationSchema.optional(),
  changeRequestId: entityIdSchema.optional(),
  proposalId: entityIdSchema.optional(),
  options: z.array(interpretationOptionSchema).optional(),
  explanation: proposalExplanationSchema.optional(),
  candidateComparison: candidateComparisonSchema.optional(),
  history: z.array(agentJobEventSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Every job payload names the run it advances; the envelope carries the production. */
export const analyzeChangeJobPayloadSchema = z.strictObject({
  jobId: entityIdSchema,
  text: z.string().min(1).max(2000),
  /** Present when the user already chose among interpretations. */
  change: typedChangeSchema.optional(),
  requestedBy: z.string().min(1).max(200),
});

export const applyProposalJobPayloadSchema = z.strictObject({
  jobId: entityIdSchema,
  proposalId: entityIdSchema,
  approvalId: entityIdSchema,
  expectedProductionVersion: productionVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  appliedBy: z.string().min(1).max(200).optional(),
});

export const verifyProposalJobPayloadSchema = z.strictObject({
  jobId: entityIdSchema,
  proposalId: entityIdSchema,
});

export type JobStage = z.infer<typeof jobStageSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type AgentJobEvent = z.infer<typeof agentJobEventSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
export type RankedScheduleCandidate = z.infer<typeof rankedScheduleCandidateSchema>;
export type CandidateComparison = z.infer<typeof candidateComparisonSchema>;
export type JobRun = z.infer<typeof jobRunSchema>;
export type AnalyzeChangeJobPayload = z.infer<typeof analyzeChangeJobPayloadSchema>;
export type ApplyProposalJobPayload = z.infer<typeof applyProposalJobPayloadSchema>;
export type VerifyProposalJobPayload = z.infer<typeof verifyProposalJobPayloadSchema>;
