import { z } from "zod";

import { entityTypeSchema } from "./entities";
import { entityIdSchema, explanationSchema, localDateSchema } from "./primitives";

/**
 * Impact and conflict contracts (SPEC.md §FR-2, DESIGN.md §3).
 *
 * Every impact carries a machine-readable `reasonCode`. The UI's "WHY" panel and
 * any model-written prose are both derived from that code, so an explanation can
 * never claim something the deterministic engine did not find.
 */

export const impactSeveritySchema = z.enum(["INFO", "WARNING", "BLOCKING"]);

/** Closed set of reasons the engine can give. Adding a reason is a deliberate act. */
export const impactReasonCodeSchema = z.enum([
  "SCENE_REQUIRES_UNAVAILABLE_CAST",
  "SCENE_AT_UNAVAILABLE_LOCATION",
  "SHOOT_DAY_CONTAINS_AFFECTED_SCENE",
  "CALL_SHEET_DERIVED_FROM_AFFECTED_SHOOT_DAY",
  "TASK_LINKED_TO_AFFECTED_ENTITY",
  "SCENE_REQUIREMENT_ADDED",
  "SCENE_REQUIREMENT_ALREADY_PRESENT",
  "SCENE_RESCHEDULED",
  "CAST_REQUIRED_ON_TARGET_DAY",
  "LOCATION_REQUIRED_ON_TARGET_DAY",
]);

export const impactSchema = z.strictObject({
  entityType: entityTypeSchema,
  entityId: entityIdSchema,
  reasonCode: impactReasonCodeSchema,
  explanation: explanationSchema,
  severity: impactSeveritySchema,
});

/** Closed set of invariant violations the validator can report. */
export const conflictCodeSchema = z.enum([
  "CAST_UNAVAILABLE_ON_SHOOT_DAY",
  "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
  "SCENE_MISSING_FROM_SHOOT_DAY",
  "SCENE_ALREADY_ON_SHOOT_DAY",
  "CROSS_PRODUCTION_REFERENCE",
  "UNKNOWN_ENTITY_REFERENCE",
  "STALE_PRODUCTION_VERSION",
]);

export const conflictSchema = z.strictObject({
  code: conflictCodeSchema,
  entityType: entityTypeSchema,
  entityId: entityIdSchema,
  date: localDateSchema.optional(),
  detail: explanationSchema,
});

export type ImpactSeverity = z.infer<typeof impactSeveritySchema>;
export type ImpactReasonCode = z.infer<typeof impactReasonCodeSchema>;
export type Impact = z.infer<typeof impactSchema>;
export type ConflictCode = z.infer<typeof conflictCodeSchema>;
export type Conflict = z.infer<typeof conflictSchema>;
