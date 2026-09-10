import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolError } from "@pca/contracts";

/**
 * How a tool answers (MCP.md §9).
 *
 * Success carries the structured output and a JSON text rendering of it, so a
 * client that ignores structured content still sees the data. Failure carries
 * the ToolError in the same two forms with isError set, so an agent reads a
 * stable code and a next step rather than a stack trace.
 */

export const successResult = (output: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(output) }],
  structuredContent: output as Record<string, unknown>,
});

export const errorResult = (error: ToolError): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error }) }],
  structuredContent: { error },
});

export const internalError = (message: string, correlationId: string): ToolError => ({
  code: "INTERNAL_ERROR",
  message,
  correlationId,
  nextStep: "Retry once; if it persists, report the correlation ID to an operator.",
});
