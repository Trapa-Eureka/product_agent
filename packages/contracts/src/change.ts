import { z } from "zod";

import { requirementTypeSchema } from "./entities";
import {
  correlationIdSchema,
  dateRangeSchema,
  entityIdSchema,
  isoDateTimeSchema,
} from "./primitives";

/**
 * Change intake contracts (SPEC.md §FR-1, DOMAIN.md §2 ChangeRequest).
 *
 * A typed change never carries a name such as "Sarah" or "Friday". Entity
 * resolution happens before this point, so everything downstream works on IDs
 * the deterministic layer can verify. This is what stops a model from inventing
 * an entity (SPEC.md §6).
 */

export const changeTypeSchema = z.enum([
  "CAST_UNAVAILABLE",
  "LOCATION_UNAVAILABLE",
  "SCENE_REQUIREMENT_CHANGED",
  "SCHEDULE_CHANGED",
]);

export const castUnavailableChangeSchema = z.strictObject({
  type: z.literal("CAST_UNAVAILABLE"),
  castId: entityIdSchema,
  unavailable: dateRangeSchema,
});

export const locationUnavailableChangeSchema = z.strictObject({
  type: z.literal("LOCATION_UNAVAILABLE"),
  locationId: entityIdSchema,
  unavailable: dateRangeSchema,
});

export const sceneRequirementChangedChangeSchema = z.strictObject({
  type: z.literal("SCENE_REQUIREMENT_CHANGED"),
  sceneId: entityIdSchema,
  requirement: z.strictObject({
    type: requirementTypeSchema,
    name: z.string().min(1).max(200),
  }),
});

export const scheduleChangedChangeSchema = z.strictObject({
  type: z.literal("SCHEDULE_CHANGED"),
  sceneIds: z.array(entityIdSchema).min(1),
  toShootDayId: entityIdSchema,
});

/** The resolved, machine-checkable form of a user's request. */
export const typedChangeSchema = z.discriminatedUnion("type", [
  castUnavailableChangeSchema,
  locationUnavailableChangeSchema,
  sceneRequirementChangedChangeSchema,
  scheduleChangedChangeSchema,
]);

/**
 * A persisted change request.
 *
 * `payload` is the typed change rather than DOMAIN.md's original `unknown`, and
 * `type` must agree with it. Storing an untyped payload would move the failure
 * from intake to the middle of impact analysis, where the cause is far less
 * obvious.
 */
export const changeRequestSchema = z
  .strictObject({
    id: entityIdSchema,
    productionId: entityIdSchema,
    type: changeTypeSchema,
    rawText: z.string().min(1).max(2000),
    payload: typedChangeSchema,
    correlationId: correlationIdSchema,
    createdBy: z.string().min(1).max(200),
    createdAt: isoDateTimeSchema,
  })
  .refine((request) => request.type === request.payload.type, {
    message: "ChangeRequest.type must match ChangeRequest.payload.type.",
    path: ["type"],
  });

export type ChangeType = z.infer<typeof changeTypeSchema>;
export type CastUnavailableChange = z.infer<typeof castUnavailableChangeSchema>;
export type LocationUnavailableChange = z.infer<typeof locationUnavailableChangeSchema>;
export type SceneRequirementChangedChange = z.infer<typeof sceneRequirementChangedChangeSchema>;
export type ScheduleChangedChange = z.infer<typeof scheduleChangedChangeSchema>;
export type TypedChange = z.infer<typeof typedChangeSchema>;
export type ChangeRequest = z.infer<typeof changeRequestSchema>;
