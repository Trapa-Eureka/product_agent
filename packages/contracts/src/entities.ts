import { z } from "zod";

import {
  dateRangeSchema,
  entityIdSchema,
  isoDateTimeSchema,
  localDateSchema,
  productionVersionSchema,
  timezoneSchema,
} from "./primitives";

/**
 * Wire representation of the production entities defined in DOMAIN.md §2.
 *
 * These schemas are the single source of truth for entity shape. The domain
 * package consumes the inferred types rather than restating them, so a field
 * cannot drift between the domain, the database adapter, and an MCP tool.
 */

export const requirementTypeSchema = z.enum([
  "PROP",
  "WARDROBE",
  "EQUIPMENT",
  "VEHICLE",
  "VFX",
  "OTHER",
]);

export const requirementStatusSchema = z.enum(["NEEDED", "READY", "UNAVAILABLE"]);
export const shootDayStatusSchema = z.enum(["DRAFT", "CONFIRMED"]);
export const callSheetStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export const taskStatusSchema = z.enum(["OPEN", "DONE"]);

/** Entity kinds a task or an impact can point at. */
export const entityTypeSchema = z.enum([
  "PRODUCTION",
  "SCENE",
  "CAST_MEMBER",
  "LOCATION",
  "REQUIREMENT",
  "SHOOT_DAY",
  "CALL_SHEET",
  "TASK",
]);

/** The subset of entity kinds a task may be attached to (DOMAIN.md §2 Task). */
export const taskRelatedEntityTypeSchema = z.enum([
  "SCENE",
  "SHOOT_DAY",
  "CALL_SHEET",
  "REQUIREMENT",
]);

export const productionSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string().min(1).max(200),
  timezone: timezoneSchema,
  version: productionVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const sceneSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  sceneNumber: z.string().min(1).max(32),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  locationId: entityIdSchema,
  requiredCastIds: z.array(entityIdSchema),
  requirementIds: z.array(entityIdSchema),
  estimatedMinutes: z
    .int()
    .positive()
    .max(24 * 60),
});

export const castMemberSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  name: z.string().min(1).max(200),
  roleName: z.string().min(1).max(200).optional(),
  unavailable: z.array(dateRangeSchema),
});

export const locationSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  name: z.string().min(1).max(200),
  unavailable: z.array(dateRangeSchema),
});

export const requirementSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  sceneId: entityIdSchema,
  type: requirementTypeSchema,
  name: z.string().min(1).max(200),
  status: requirementStatusSchema,
});

export const shootDaySchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  date: localDateSchema,
  sceneIds: z.array(entityIdSchema),
  status: shootDayStatusSchema,
});

export const callSheetSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  shootDayId: entityIdSchema,
  version: z.int().positive(),
  status: callSheetStatusSchema,
});

export const taskSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  title: z.string().min(1).max(300),
  relatedEntityType: taskRelatedEntityTypeSchema,
  relatedEntityId: entityIdSchema,
  status: taskStatusSchema,
});

export type RequirementType = z.infer<typeof requirementTypeSchema>;
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;
export type ShootDayStatus = z.infer<typeof shootDayStatusSchema>;
export type CallSheetStatus = z.infer<typeof callSheetStatusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type TaskRelatedEntityType = z.infer<typeof taskRelatedEntityTypeSchema>;
export type Production = z.infer<typeof productionSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type CastMember = z.infer<typeof castMemberSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type ShootDay = z.infer<typeof shootDaySchema>;
export type CallSheet = z.infer<typeof callSheetSchema>;
export type Task = z.infer<typeof taskSchema>;
