/**
 * Contracts shared across every boundary: HTTP, MCP, queue, WebSocket, and
 * persistence (ARCHITECTURE.md §5).
 *
 * Nothing here imports a framework, a database driver, or a cloud SDK. Both the
 * domain and the adapters depend on this package, which is what keeps a field
 * from meaning one thing in Mongo and another in an MCP response.
 */
export * from "./primitives";
export * from "./entities";
export * from "./change";
export * from "./impact";
export * from "./proposal";
export * from "./approval";
export * from "./audit";
export * from "./errors";
export * from "./job";
export * from "./mcp";
