import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolError } from "@pca/contracts";

/**
 * How a tool answers (MCP.md §9).
 *
 * Success carries the structured output and a JSON text rendering of it, so a
 * client that ignores structured content still sees the data. Failure carries
 * the ToolError as JSON text with isError set, and deliberately no
 * structuredContent: clients validate structuredContent against the tool's
 * advertised output schema, and an error is not an output. An agent reads a
 * stable code and a next step from the text rather than a stack trace.
 */

export const successResult = (output: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(output) }],
  structuredContent: output as Record<string, unknown>,
});

export const errorResult = (error: ToolError): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error }) }],
});

/**
 * Reads the ToolError back out of an error result, for clients and tests.
 *
 * Takes `unknown` on purpose: the client's result type is a union that also
 * admits a legacy `{ toolResult }` shape, and a reader of results should not
 * be coupled to either side's exact type. Anything that is not an error result
 * with a text item reads as null.
 */
export const readToolError = (result: unknown): ToolError | null => {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const candidate = result as { isError?: unknown; content?: unknown };
  if (candidate.isError !== true || !Array.isArray(candidate.content)) {
    return null;
  }
  const first: unknown = candidate.content[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  const item = first as { type?: unknown; text?: unknown };
  if (item.type !== "text" || typeof item.text !== "string") {
    return null;
  }
  return (JSON.parse(item.text) as { error: ToolError }).error;
};

export const internalError = (message: string, correlationId: string): ToolError => ({
  code: "INTERNAL_ERROR",
  message,
  correlationId,
  nextStep: "Retry once; if it persists, report the correlation ID to an operator.",
});
