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

export const auditEventSchema = z.strictObject({
  id: entityIdSchema,
  productionId: entityIdSchema,
  actorType: actorTypeSchema,
  actorId: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(120),
  entityType: entityTypeSchema.optional(),
  entityId: entityIdSchema.optional(),
  correlationId: correlationIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateTimeSchema,
});

export type ActorType = z.infer<typeof actorTypeSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
