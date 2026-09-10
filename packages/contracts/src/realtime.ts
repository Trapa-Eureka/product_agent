import { z } from "zod";

import { agentJobEventSchema, jobRunSchema } from "./job";
import {
  entityIdSchema,
  explanationSchema,
  isoDateTimeSchema,
  productionVersionSchema,
} from "./primitives";
import { proposalSchema, proposalStatusSchema, validationStatusSchema } from "./proposal";

/**
 * Realtime contracts (SPEC.md §7, ARCHITECTURE.md §11, TASK-404).
 *
 * The socket is a notification channel, not a store. Every server message is
 * either a job event that a `JobRun` also holds, or a proposal status that
 * the proposal record also holds. A client that missed a message re-reads
 * the record; it never needs the message to be correct.
 */

export const REALTIME_PROTOCOL_VERSION = 1;

/** A proposal's status as of a write; what the proposal record also says. */
export const proposalStatusNotificationSchema = z.strictObject({
  productionId: entityIdSchema,
  proposalId: entityIdSchema,
  changeRequestId: entityIdSchema,
  status: proposalStatusSchema,
  validationStatus: validationStatusSchema,
  summary: explanationSchema,
  occurredAt: isoDateTimeSchema,
});

/** What the application publishes; the gateway forwards it to subscribers of the production. */
export const realtimeNotificationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("job"), event: agentJobEventSchema }),
  z.strictObject({ type: z.literal("proposal"), proposal: proposalStatusNotificationSchema }),
]);

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribe"), productionId: entityIdSchema }),
  z.strictObject({ type: z.literal("unsubscribe"), productionId: entityIdSchema }),
  z.strictObject({ type: z.literal("ping") }),
]);

export const realtimeErrorCodeSchema = z.enum([
  "MALFORMED_MESSAGE",
  "PRODUCTION_UNAUTHORIZED",
  "SUBSCRIPTION_LIMIT",
]);

export const realtimeServerMessageSchema = z.discriminatedUnion("type", [
  /** First message on every connection. Names the protocol and the canonical source. */
  z.strictObject({
    type: z.literal("welcome"),
    protocolVersion: z.literal(REALTIME_PROTOCOL_VERSION),
    serverTime: isoDateTimeSchema,
    /** Reminder to the client: recover from the records, not from replayed messages. */
    canonicalSource: z.literal("rest"),
  }),
  z.strictObject({ type: z.literal("subscribed"), productionId: entityIdSchema }),
  z.strictObject({ type: z.literal("unsubscribed"), productionId: entityIdSchema }),
  z.strictObject({ type: z.literal("job"), event: agentJobEventSchema }),
  z.strictObject({ type: z.literal("proposal"), proposal: proposalStatusNotificationSchema }),
  z.strictObject({ type: z.literal("pong"), serverTime: isoDateTimeSchema }),
  z.strictObject({
    type: z.literal("error"),
    code: realtimeErrorCodeSchema,
    message: explanationSchema,
  }),
]);

/** Proposal statuses a coordinator still has to act on or watch. */
export const OPEN_PROPOSAL_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED"] as const;

/**
 * What a client reads to recover after losing the socket (TASK-405). The
 * REST API serves it; the realtime client applies it and then resumes
 * applying live notifications on top.
 */
export const recoverySnapshotSchema = z.strictObject({
  productionId: entityIdSchema,
  productionVersion: productionVersionSchema,
  asOf: isoDateTimeSchema,
  /** Newest first. */
  jobs: z.array(jobRunSchema),
  openProposals: z.array(proposalSchema),
});

export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;
export type ProposalStatusNotification = z.infer<typeof proposalStatusNotificationSchema>;
export type RealtimeNotification = z.infer<typeof realtimeNotificationSchema>;
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;
export type RealtimeErrorCode = z.infer<typeof realtimeErrorCodeSchema>;
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;
