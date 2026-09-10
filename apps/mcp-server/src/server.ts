import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { IdFactory, UseCaseResult } from "@pca/application";
import { InfrastructureError, describeFailure, randomIdFactory } from "@pca/application";
import type { CallContext, ToolHandlers } from "./handler-types";
import type { McpToolName, ToolError } from "@pca/contracts";
import { MCP_TOOL_CONTRACTS, MCP_TOOL_NAMES } from "@pca/contracts";

import type { ServerContext } from "./context";
import { authorize } from "./context";
import { TOOL_DESCRIPTIONS } from "./descriptions";
import type { Logger } from "./logging";
import { silentLogger } from "./logging";
import { errorResult, internalError, successResult } from "./tool-result";

/**
 * MCP server foundation (MCP.md §2-3, TASK-201).
 *
 * The tool surface is the registry, not this file. A tool is advertised only
 * if MCP_TOOL_CONTRACTS defines it and a handler is supplied for it, its
 * input is validated by the registry's strict schema before the handler runs,
 * and its output is validated by the registry's output schema before the
 * client sees it. A handler that returns the wrong shape is a server bug and
 * is reported as one, never forwarded.
 *
 * Every call: authorise the production against the server context, validate,
 * run, validate, log. Handlers see a correlation ID and the acting identity;
 * they never see the transport.
 */

export type { CallContext, ToolHandler, ToolHandlers } from "./handler-types";

/**
 * Dispatch erases the per-tool generic on purpose. The registry's input schema
 * has already proved the input matches this tool, and the output schema will
 * prove the result does, so the types are re-established at runtime on both
 * sides of this one call. Handlers themselves stay fully typed.
 */
type ErasedHandler = (input: unknown, call: CallContext) => Promise<UseCaseResult<unknown>>;

export type McpServerOptions = {
  readonly handlers: ToolHandlers;
  readonly context: ServerContext;
  readonly logger?: Logger;
  readonly ids?: IdFactory;
  readonly serverInfo?: { readonly name: string; readonly version: string };
};

export type ProductionChangeServer = {
  readonly server: Server;
  readonly registeredTools: readonly McpToolName[];
};

const toolDefinition = (name: McpToolName): Tool => {
  const contract = MCP_TOOL_CONTRACTS[name];
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: z.toJSONSchema(contract.input) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(contract.output) as Tool["outputSchema"],
  };
};

const firstIssue = (error: z.ZodError): { path: string; message: string } => {
  const issue = error.issues[0];
  return { path: issue?.path.join(".") ?? "<root>", message: issue?.message ?? "unknown issue" };
};

export const createProductionChangeServer = (options: McpServerOptions): ProductionChangeServer => {
  const logger = options.logger ?? silentLogger;
  const ids = options.ids ?? randomIdFactory;
  const registeredTools = MCP_TOOL_NAMES.filter((name) => options.handlers[name] !== undefined);
  const registered = new Set<string>(registeredTools);

  const server = new Server(
    options.serverInfo ?? { name: "production-change-agent", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registeredTools.map(toolDefinition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const startedAt = Date.now();
    const correlationId = ids.next("corr");
    const rawName = request.params.name;

    const finish = (
      result: CallToolResult,
      outcome: "ok" | "error" | "unauthorized" | "invalid" | "unknown_tool",
      code?: ToolError["code"],
    ): CallToolResult => {
      logger.log(outcome === "ok" ? "info" : "warn", "tool_call", {
        tool: rawName,
        correlationId,
        durationMs: Date.now() - startedAt,
        outcome,
        ...(code === undefined ? {} : { code }),
      });
      return result;
    };

    if (!registered.has(rawName)) {
      return finish(
        errorResult({
          code: "TOOL_UNAUTHORIZED",
          message: `Tool "${rawName}" is not available on this server.`,
          correlationId,
          actual: rawName,
          nextStep: `Call one of: ${registeredTools.join(", ")}.`,
        }),
        "unknown_tool",
        "TOOL_UNAUTHORIZED",
      );
    }
    const name = rawName as McpToolName;
    const contract = MCP_TOOL_CONTRACTS[name];

    const parsedInput = contract.input.safeParse(request.params.arguments ?? {});
    if (!parsedInput.success) {
      const { path, message } = firstIssue(parsedInput.error);
      return finish(
        errorResult({
          code: "INVALID_INPUT",
          message: `Input for ${name} is invalid at "${path}": ${message}`,
          correlationId,
          actual: path,
          nextStep: "Correct the input to match the tool's schema. Unknown fields are rejected.",
        }),
        "invalid",
        "INVALID_INPUT",
      );
    }
    const input = parsedInput.data;

    const denied = authorize(options.context, input.productionId);
    if (denied !== null) {
      return finish(errorResult({ ...denied, correlationId }), "unauthorized", denied.code);
    }

    const handler = options.handlers[name] as ErasedHandler | undefined;
    if (handler === undefined) {
      return finish(
        errorResult(internalError(`${name} is registered without a handler.`, correlationId)),
        "error",
        "INTERNAL_ERROR",
      );
    }
    let result: UseCaseResult<unknown>;
    try {
      result = await handler(input, { correlationId, actor: options.context.actor });
    } catch (error) {
      logger.log("error", "tool_crash", {
        tool: name,
        correlationId,
        error: describeFailure(error, correlationId),
        ...(error instanceof InfrastructureError ? { boundary: error.boundary } : {}),
      });
      // An infrastructure fault names its boundary so the operator knows where to look;
      // anything else stays opaque, because a stack trace is not a tool result.
      const message =
        error instanceof InfrastructureError
          ? `${name} failed at ${error.boundary}. Retry once the store is reachable.`
          : `${name} failed unexpectedly.`;
      return finish(errorResult(internalError(message, correlationId)), "error", "INTERNAL_ERROR");
    }

    if (!result.ok) {
      const error: ToolError = {
        ...result.error,
        correlationId: result.error.correlationId ?? correlationId,
      };
      return finish(errorResult(error), "error", error.code);
    }

    const parsedOutput = contract.output.safeParse(result.value);
    if (!parsedOutput.success) {
      const { path, message } = firstIssue(parsedOutput.error);
      logger.log("error", "tool_output_invalid", { tool: name, correlationId, path, message });
      return finish(
        errorResult(
          internalError(`${name} produced output that violates its contract.`, correlationId),
        ),
        "error",
        "INTERNAL_ERROR",
      );
    }

    return finish(successResult(parsedOutput.data), "ok");
  });

  return { server, registeredTools };
};
