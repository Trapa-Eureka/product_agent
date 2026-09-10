import { z } from "zod";

import { requirementTypeSchema, taskRelatedEntityTypeSchema } from "./entities";
import { conflictSchema, impactSchema } from "./impact";
import {
  dateRangeSchema,
  entityIdSchema,
  explanationSchema,
  isoDateTimeSchema,
  productionVersionSchema,
  proposalDigestSchema,
} from "./primitives";

/**
 * Proposal contracts (SPEC.md §FR-5, MCP.md §7).
 *
 * Operations are a closed, high-level set. There is no generic "update document"
 * operation, which is what keeps `apply_approved_proposal` safe to expose to an
 * agent: the worst a malformed proposal can express is still a production
 * command the domain knows how to validate.
 */

export const moveScenesOperationSchema = z.strictObject({
  type: z.literal("MOVE_SCENES"),
  sceneIds: z.array(entityIdSchema).min(1),
  fromShootDayId: entityIdSchema,
  toShootDayId: entityIdSchema,
});

export const addSceneRequirementOperationSchema = z.strictObject({
  type: z.literal("ADD_SCENE_REQUIREMENT"),
  sceneId: entityIdSchema,
  requirementType: requirementTypeSchema,
  name: z.string().min(1).max(200),
});

export const createPreparationTaskOperationSchema = z.strictObject({
  type: z.literal("CREATE_PREPARATION_TASK"),
  title: z.string().min(1).max(300),
  relatedEntityType: taskRelatedEntityTypeSchema,
  relatedEntityId: entityIdSchema,
});

export const markCallSheetStaleOperationSchema = z.strictObject({
  type: z.literal("MARK_CALL_SHEET_STALE"),
  callSheetId: entityIdSchema,
});

/**
 * Records the fact behind an availability change on the entity itself, so the
 * production remembers it after the remedy is applied. Without this, "Sarah
 * cannot shoot Friday" would move her scenes and then forget why.
 */
export const recordCastUnavailabilityOperationSchema = z.strictObject({
  type: z.literal("RECORD_CAST_UNAVAILABILITY"),
  castId: entityIdSchema,
  unavailable: dateRangeSchema,
});

export const recordLocationUnavailabilityOperationSchema = z.strictObject({
  type: z.literal("RECORD_LOCATION_UNAVAILABILITY"),
  locationId: entityIdSchema,
  unavailable: dateRangeSchema,
});

export const proposedOperationSchema = z.discriminatedUnion("type", [
  recordCastUnavailabilityOperationSchema,
  recordLocationUnavailabilityOperationSchema,
  moveScenesOperationSchema,
  addSceneRequirementOperationSchema,
  createPreparationTaskOperationSchema,
  markCallSheetStaleOperationSchema,
]);

/** Operations that state a fact about the world rather than change the plan. */
export const FACT_OPERATION_TYPES = [
  "RECORD_CAST_UNAVAILABILITY",
  "RECORD_LOCATION_UNAVAILABILITY",
] as const;

export const validationStatusSchema = z.enum(["VALID", "INVALID"]);

export const proposalStatusSchema = z.enum([
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "APPLIED",
  "FAILED",
]);

/**
 * `digest` is a hash of the operations plus the base production version. An
 * approval references it, so editing a proposal after approval invalidates that
 * approval instead of silently widening it (INV-6).
 */
export const proposalSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  changeRequestId: entityIdSchema,
  baseProductionVersion: productionVersionSchema,
  operations: z.array(proposedOperationSchema).min(1),
  impacts: z.array(impactSchema),
  conflicts: z.array(conflictSchema),
  warnings: z.array(explanationSchema),
  validationStatus: validationStatusSchema,
  status: proposalStatusSchema,
  digest: proposalDigestSchema,
  summary: explanationSchema,
  createdAt: isoDateTimeSchema,
});

export type RecordCastUnavailabilityOperation = z.infer<
  typeof recordCastUnavailabilityOperationSchema
>;
export type RecordLocationUnavailabilityOperation = z.infer<
  typeof recordLocationUnavailabilityOperationSchema
>;
export type MoveScenesOperation = z.infer<typeof moveScenesOperationSchema>;
export type AddSceneRequirementOperation = z.infer<typeof addSceneRequirementOperationSchema>;
export type CreatePreparationTaskOperation = z.infer<typeof createPreparationTaskOperationSchema>;
export type MarkCallSheetStaleOperation = z.infer<typeof markCallSheetStaleOperationSchema>;
export type ProposedOperation = z.infer<typeof proposedOperationSchema>;
export type ValidationStatus = z.infer<typeof validationStatusSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
