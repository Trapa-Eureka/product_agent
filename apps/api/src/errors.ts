import type { Response } from "express";

import type { ToolError, ToolErrorCode } from "@pca/contracts";

/**
 * Errors over HTTP (TASK-110).
 *
 * The body is the same `ToolError` an MCP client sees, so a code means one
 * thing on every surface. The status is derived from the code, never chosen
 * per route, so a new route cannot invent a mapping.
 */
export const HTTP_STATUS_BY_CODE: Readonly<Record<ToolErrorCode, number>> = {
  ENTITY_NOT_FOUND: 404,
  ENTITY_AMBIGUOUS: 409,
  UNSUPPORTED_CHANGE: 422,
  PRODUCTION_VERSION_MISMATCH: 409,
  PROPOSAL_INVALID: 422,
  APPROVAL_REQUIRED: 403,
  APPROVAL_MISMATCH: 409,
  CONSTRAINT_VIOLATION: 422,
  IDEMPOTENCY_CONFLICT: 409,
  TOOL_UNAUTHORIZED: 403,
  UNAUTHENTICATED: 401,
  INVALID_INPUT: 400,
  INTERNAL_ERROR: 500,
};

export type ErrorBody = { readonly error: ToolError };

export const sendError = (response: Response, error: ToolError, correlationId: string): void => {
  const body: ErrorBody = {
    error: { ...error, correlationId: error.correlationId ?? correlationId },
  };
  response.status(HTTP_STATUS_BY_CODE[error.code]).json(body);
};

export const invalidInput = (message: string, path?: string): ToolError => ({
  code: "INVALID_INPUT",
  message,
  ...(path === undefined ? {} : { actual: path }),
  nextStep: "Correct the request body or query and try again.",
});
