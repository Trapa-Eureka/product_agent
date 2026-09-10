/**
 * MCP server: the controlled capability boundary between an agent and the
 * production application (ARCHITECTURE.md §13).
 *
 * Tools are registered from the shared contract registry, validated on the
 * way in and out, authorised against a server-side context, and logged to
 * stderr. Handlers for the individual tools arrive in TASK-202 onwards.
 */
export * from "./context";
export * from "./logging";
export * from "./descriptions";
export * from "./tool-result";
export * from "./server";
export * from "./handlers";
