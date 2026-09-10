import { z } from "zod";

import { entityTypeSchema } from "./entities";
import { correlationIdSchema, entityIdSchema, isoDateTimeSchema } from "./primitives";

/**
 * Audit contracts (SPEC.md §FR-9, DESIGN.md §7).
 *
 * Audit records hold actions, structured reasons, and results. They never hold
 * model chain-of-thought (ARCHITECTURE.md §15).
 */

export const actorTypeSchema = z.enum(["USER", "AGENT", "SYSTEM"]);

/**
 * What an audit event can be about: any production entity, plus the workflow
 * records that the audit view narrates ("Agent proposed P-104").
 */
export const auditSubjectTypeSchema = z.enum([
  ...entityTypeSchema.options,
  "CHANGE_REQUEST",
  "PROPOSAL",
  "APPROVAL",
  "JOB",
]);

export const auditEventSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  actorType: actorTypeSchema,
  actorId: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(120),
  entityType: auditSubjectTypeSchema.optional(),
  entityId: entityIdSchema.optional(),
  correlationId: correlationIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateTimeSchema,
});

export type ActorType = z.infer<typeof actorTypeSchema>;
export type AuditSubjectType = z.infer<typeof auditSubjectTypeSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
