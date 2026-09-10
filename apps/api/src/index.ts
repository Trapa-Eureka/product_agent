/**
 * REST API over the application (TASK-110): routes, error mapping, and the
 * HTTP server that also hosts the WebSocket gateway. `main.ts` is the
 * process entry point; everything here is importable for tests.
 */
export * from "./app";
export * from "./errors";
export * from "./invoke";
export * from "./logging";
export * from "./server";
