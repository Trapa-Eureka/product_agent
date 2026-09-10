import { z } from "zod";

/**
 * Building blocks shared by every contract in this package.
 *
 * These exist so that "an ID", "a production-local date", and "a timestamp"
 * mean exactly one thing at every boundary: HTTP, MCP, queue, and persistence.
 */

/**
 * Stable entity identifier. Fixture IDs such as `S07`, `CAST-SARAH`, and
 * `SD-2026-09-18` are deliberately human-readable so failures name something a
 * reader recognises (TESTING.md §3).
 */
export const entityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
    message: "Entity IDs may contain letters, digits, dot, underscore, colon, and hyphen.",
  });

/** A date in the production's local timezone, `YYYY-MM-DD`. Never a timestamp. */
export const localDateSchema = z.iso.date();

/** A UTC instant, e.g. `2026-09-18T10:00:00.000Z`. System-generated. */
export const isoDateTimeSchema = z.iso.datetime();

/** IANA timezone name, validated against the runtime's own timezone database. */
export const timezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Expected an IANA timezone name such as Asia/Manila." },
);

/**
 * Optimistic-concurrency counter for a production. Every consequential mutation
 * increments it (INV-7), which is what makes a stale proposal detectable.
 */
export const productionVersionSchema = z.int().nonnegative();

/** Replay guard for write operations (INV-8). */
export const idempotencyKeySchema = z.string().min(8).max(200);

/**
 * Hash binding an approval to the exact proposal content it approved (INV-6).
 * Hex-encoded SHA-256.
 */
export const proposalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: "Expected a lowercase hex SHA-256 digest.",
});

/** Ties an HTTP request, agent job, MCP call, and proposal together in logs. */
export const correlationIdSchema = z.string().min(1).max(128);

/** Free-text meant for a human reader. Never empty, so the UI never renders a blank reason. */
export const explanationSchema = z.string().min(1).max(2000);

/**
 * An inclusive range of production-local dates. Lexicographic comparison is
 * valid for `YYYY-MM-DD`, so no date library is needed here.
 */
export const dateRangeSchema = z
  .strictObject({
    start: localDateSchema,
    end: localDateSchema,
  })
  .refine((range) => range.start <= range.end, {
    message: "DateRange.end must be on or after DateRange.start.",
    path: ["end"],
  });

export type EntityId = z.infer<typeof entityIdSchema>;
export type LocalDate = z.infer<typeof localDateSchema>;
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type Timezone = z.infer<typeof timezoneSchema>;
export type ProductionVersion = z.infer<typeof productionVersionSchema>;
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
export type ProposalDigest = z.infer<typeof proposalDigestSchema>;
export type CorrelationId = z.infer<typeof correlationIdSchema>;
export type DateRange = z.infer<typeof dateRangeSchema>;
