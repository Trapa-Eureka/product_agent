import { z } from "zod";

import { entityTypeSchema } from "./entities";
import { entityIdSchema, explanationSchema } from "./primitives";

/**
 * User-facing explanation contracts (DESIGN.md §3 and §4, TASK-306).
 *
 * An explanation is assembled from deterministic results: operations,
 * impacts, conflicts, and the production snapshot. A model may add a
 * `narrative` paragraph on top, but every effect and operation line is
 * derived from data, so the UI, the REST API, and an MCP client all show the
 * same account of what a proposal does, and none of them can show a claim the
 * engine did not make.
 */

/** `POSITIVE` renders as `+`, `ATTENTION` as `!` (DESIGN.md §4). */
export const explanationEffectToneSchema = z.enum(["POSITIVE", "ATTENTION"]);

export const explanationEffectSchema = z.strictObject({
  tone: explanationEffectToneSchema,
  text: explanationSchema,
  entityType: entityTypeSchema.optional(),
  entityId: entityIdSchema.optional(),
});

/** The proposal comparison card: what changes, what it does, and the exact operations. */
export const proposalExplanationSchema = z.strictObject({
  headline: explanationSchema,
  effects: z.array(explanationEffectSchema),
  operations: z.array(explanationSchema).min(1),
  /** Optional prose from the model, grounded in the same findings. */
  narrative: explanationSchema.optional(),
});

/** The impact panel: blocking findings, what is affected, and why (DESIGN.md §3). */
export const impactExplanationSchema = z.strictObject({
  blocking: z.array(explanationSchema),
  affected: z.strictObject({
    scenes: z.array(z.string().min(1)),
    shootDays: z.array(z.string().min(1)),
    callSheets: z.array(z.string().min(1)),
    tasks: z.array(z.string().min(1)),
    castMembers: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
  }),
  why: z.array(explanationSchema),
});

export type ExplanationEffectTone = z.infer<typeof explanationEffectToneSchema>;
export type ExplanationEffect = z.infer<typeof explanationEffectSchema>;
export type ProposalExplanation = z.infer<typeof proposalExplanationSchema>;
export type ImpactExplanation = z.infer<typeof impactExplanationSchema>;
