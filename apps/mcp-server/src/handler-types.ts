import type { UseCaseResult } from "@pca/application";
import type { McpToolInput, McpToolName, McpToolOutput } from "@pca/contracts";

import type { ServerContext } from "./context";

/**
 * The handler contract, separate from the transport so the REST API can run
 * the same handlers without importing the MCP SDK (TASK-110).
 */

export type CallContext = {
  readonly correlationId: string;
  readonly actor: ServerContext["actor"];
};

export type ToolHandler<TName extends McpToolName> = (
  input: McpToolInput<TName>,
  call: CallContext,
) => Promise<UseCaseResult<McpToolOutput<TName>>>;

export type ToolHandlers = { readonly [TName in McpToolName]?: ToolHandler<TName> };
