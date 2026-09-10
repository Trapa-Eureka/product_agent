/**
 * Application layer: use cases and the ports they depend on.
 *
 * This package coordinates the domain and storage. It imports no HTTP server,
 * database driver, cloud SDK, MCP transport, or model SDK, and an ESLint rule
 * enforces that.
 */
export * from "./ports";
export * from "./result";
export * from "./use-cases";
