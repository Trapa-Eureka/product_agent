import type { UseCaseResult } from "@pca/application";
import { InfrastructureError, describeFailure } from "@pca/application";
import type { McpToolName, McpToolOutput } from "@pca/contracts";
import { MCP_TOOL_CONTRACTS } from "@pca/contracts";
import type { CallContext, ToolHandlers } from "@pca/mcp-server/handlers";

import type { ApiLogger } from "./logging";

/**
 * One way to run a tool over HTTP (TASK-110).
 *
 * The REST API reuses the MCP tool handlers, so a route and a tool validate
 * the same input against the same contract, run the same use case, and
 * validate the same output. A route cannot expose a capability the tool
 * surface does not have, and the two surfaces cannot drift apart.
 */

type ErasedHandler = (input: unknown, call: CallContext) => Promise<UseCaseResult<unknown>>;

export const invokeTool = async <TName extends McpToolName>(
  handlers: ToolHandlers,
  name: TName,
  rawInput: unknown,
  call: CallContext,
  logger: ApiLogger,
): Promise<UseCaseResult<McpToolOutput<TName>>> => {
  const contract = MCP_TOOL_CONTRACTS[name];
  const parsed = contract.input.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `The request is malformed: ${issue?.message ?? "unknown issue"}.`,
        correlationId: call.correlationId,
        actual: issue?.path.join(".") ?? "<root>",
        nextStep: "Correct the request and try again.",
      },
    };
  }
  const handler = handlers[name] as ErasedHandler | undefined;
  if (handler === undefined) {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `${name} is not wired on this server.`,
        correlationId: call.correlationId,
      },
    };
  }
  let result: UseCaseResult<unknown>;
  try {
    result = await handler(parsed.data, call);
  } catch (error) {
    logger.log("error", "route_crash", {
      tool: name,
      correlationId: call.correlationId,
      error: describeFailure(error, call.correlationId),
    });
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message:
          error instanceof InfrastructureError
            ? `${name} failed at ${error.boundary}. Retry once the store is reachable.`
            : `${name} failed unexpectedly.`,
        correlationId: call.correlationId,
      },
    };
  }
  if (!result.ok) return result;
  const output = contract.output.safeParse(result.value);
  if (!output.success) {
    logger.log("error", "route_output_invalid", {
      tool: name,
      correlationId: call.correlationId,
      path: output.error.issues[0]?.path.join(".") ?? "<root>",
    });
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `${name} produced output that violates its contract.`,
        correlationId: call.correlationId,
      },
    };
  }
  return { ok: true, value: output.data as McpToolOutput<TName> };
};
