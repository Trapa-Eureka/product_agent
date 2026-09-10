import { z } from "zod";

import { typedChangeSchema } from "./change";
import { conflictSchema, impactSchema } from "./impact";
import { rejectedScheduleDaySchema, scheduleCandidateSchema } from "./mcp";
import { entityIdSchema, explanationSchema, localDateSchema } from "./primitives";

/**
 * Model I/O contracts (ARCHITECTURE.md §7).
 *
 * These are the only shapes a model adapter may produce, whatever provider
 * sits behind it. Every output is schema-validated before use, and every ID
 * or candidate in an output must come from the input it was given: a model
 * may interpret, explain, and rank, but it cannot invent an entity or a day.
 */

/** What the interpreter is allowed to know: names it may resolve to IDs, and the shoot days a weekday resolves against. */
export const interpretationContextSchema = z.strictObject({
  castMembers: z.array(
    z.strictObject({
      id: entityIdSchema,
      name: z.string().min(1),
      roleName: z.string().min(1).optional(),
    }),
  ),
  locations: z.array(z.strictObject({ id: entityIdSchema, name: z.string().min(1) })),
  scenes: z.array(
    z.strictObject({
      id: entityIdSchema,
      sceneNumber: z.string().min(1),
      title: z.string().min(1).optional(),
    }),
  ),
  shootDays: z.array(z.strictObject({ id: entityIdSchema, date: localDateSchema })),
  /** The production-local date "today", for relative phrases. */
  today: localDateSchema,
});

export const interpretChangeInputSchema = z.strictObject({
  productionId: entityIdSchema,
  text: z.string().min(1).max(2000),
  context: interpretationContextSchema,
});

/** One way the sentence could be read, when it could be read several ways. */
export const interpretationOptionSchema = z.strictObject({
  label: z.string().min(1).max(200),
  change: typedChangeSchema,
});

export const interpretedChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("RESOLVED"),
    change: typedChangeSchema,
    confidence: z.number().min(0).max(1),
    rationale: explanationSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("AMBIGUOUS"),
    question: explanationSchema,
    options: z.array(interpretationOptionSchema).min(2).max(6),
  }),
  z.strictObject({
    kind: z.literal("UNSUPPORTED"),
    reason: explanationSchema,
  }),
]);

export const explainImpactInputSchema = z.strictObject({
  productionId: entityIdSchema,
  rawText: z.string().min(1).max(2000),
  change: typedChangeSchema,
  impacts: z.array(impactSchema),
  conflicts: z.array(conflictSchema),
  resolvedConflicts: z.array(conflictSchema).optional(),
  warnings: z.array(explanationSchema).optional(),
});

export const explanationOutputSchema = z.strictObject({
  explanation: explanationSchema,
});

export const rankCandidatesInputSchema = z.strictObject({
  productionId: entityIdSchema,
  change: typedChangeSchema,
  candidates: z.array(scheduleCandidateSchema).min(1),
  rejected: z.array(rejectedScheduleDaySchema).optional(),
});

/** A permutation of the input candidates with a reason each; nothing added, nothing dropped. */
export const rankedCandidateSchema = z.strictObject({
  shootDayId: entityIdSchema,
  rank: z.int().positive(),
  reason: explanationSchema,
});

export const rankedCandidatesOutputSchema = z.strictObject({
  ranked: z.array(rankedCandidateSchema).min(1),
});

export type InterpretationContext = z.infer<typeof interpretationContextSchema>;
export type InterpretChangeInput = z.infer<typeof interpretChangeInputSchema>;
export type InterpretationOption = z.infer<typeof interpretationOptionSchema>;
export type InterpretedChange = z.infer<typeof interpretedChangeSchema>;
export type ExplainImpactInput = z.infer<typeof explainImpactInputSchema>;
export type ExplanationOutput = z.infer<typeof explanationOutputSchema>;
export type RankCandidatesInput = z.infer<typeof rankCandidatesInputSchema>;
export type RankedCandidate = z.infer<typeof rankedCandidateSchema>;
export type RankedCandidatesOutput = z.infer<typeof rankedCandidatesOutputSchema>;
