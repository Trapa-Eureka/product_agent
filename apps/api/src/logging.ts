import type { Logger, LogFields } from "@pca/application";

/** Structured JSON lines on stderr, the same shared port `@pca/application` and the MCP server use (TASK-804). */
export type ApiLogger = Logger;
export type ApiLogFields = LogFields;

export const stderrApiLogger = (now: () => string = () => new Date().toISOString()): ApiLogger => ({
  log: (level, event, fields = {}) => {
    process.stderr.write(`${JSON.stringify({ ts: now(), level, event, ...fields })}\n`);
  },
});

export const silentApiLogger: ApiLogger = { log: () => undefined };
