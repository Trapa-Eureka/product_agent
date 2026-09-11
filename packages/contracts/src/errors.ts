import { z } from "zod";

import { correlationIdSchema, explanationSchema } from "./primitives";

/**
 * Error contracts (MCP.md §9, WORKFLOW.md §10).
 *
 * An error is feedback for a human and for an agent. Each one carries a stable
 * code and, wherever it is safe, the expected and actual values plus the next
 * safe action, so a caller can recover without guessing.
 */

export const toolErrorCodeSchema = z.enum([
  "ENTITY_NOT_FOUND",
  "ENTITY_AMBIGUOUS",
  "UNSUPPORTED_CHANGE",
  "PRODUCTION_VERSION_MISMATCH",
  "PROPOSAL_INVALID",
  "APPROVAL_REQUIRED",
  "APPROVAL_MISMATCH",
  "CONSTRAINT_VIOLATION",
  "IDEMPOTENCY_CONFLICT",
  "TOOL_UNAUTHORIZED",
  /** No verified identity on the call (TASK-914). HTTP 401; never returned by an MCP tool. */
  "UNAUTHENTICATED",
  /** The caller exceeded a request quota (TASK-917). HTTP 429 with Retry-After; never returned by an MCP tool. */
  "RATE_LIMITED",
  /** The named job is not the one for this proposal, type, or stage (TASK-919). HTTP 409; never returned by an MCP tool. */
  "JOB_MISMATCH",
  "INVALID_INPUT",
  "INTERNAL_ERROR",
]);

export const toolErrorSchema = z.strictObject({
  code: toolErrorCodeSchema,
  message: explanationSchema,
  correlationId: correlationIdSchema.optional(),
  /** What the caller supplied or assumed, when naming it does not leak secrets. */
  expected: z.string().max(500).optional(),
  actual: z.string().max(500).optional(),
  /** The next safe action, e.g. "Reload production state and re-run simulation." */
  nextStep: explanationSchema.optional(),
});

export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
