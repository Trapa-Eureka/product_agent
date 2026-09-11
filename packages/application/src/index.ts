/**
 * Application layer: use cases and the ports they depend on.
 *
 * This package coordinates the domain and storage. It imports no HTTP server,
 * database driver, cloud SDK, MCP transport, or model SDK, and an ESLint rule
 * enforces that.
 */
export * from "./ports";
export * from "./result";
export * from "./infrastructure-error";
export * from "./explanation";
export * from "./data-policy";
export * from "./jobs";
export * from "./realtime";
export * from "./use-cases";
