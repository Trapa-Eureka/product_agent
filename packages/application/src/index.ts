/**
 * Application layer: use cases and the ports they depend on.
 *
 * This package coordinates the domain and storage. It imports no HTTP server,
 * database driver, cloud SDK, MCP transport, or model SDK, and an ESLint rule
 * enforces that. Use cases arrive in TASK-103 onwards; TASK-101 establishes the
 * ports they will be written against.
 */
export * from "./ports";
