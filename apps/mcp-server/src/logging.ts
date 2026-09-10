import type { Logger, LogFields, LogLevel } from "@pca/application";

/**
 * Structured logging for the MCP server (SPEC.md §8 Observability).
 *
 * Lines go to stderr as JSON, never to stdout: stdout is the stdio transport,
 * and a stray log line there corrupts the protocol stream. Each tool call logs
 * its name, correlation ID, duration, and outcome or error code, and nothing
 * else. No prompt text, no chain-of-thought, no entity payloads.
 *
 * `Logger`/`LogFields`/`LogLevel` are the shared port `@pca/application`
 * exports (TASK-804) — re-exported here under their original names so
 * nothing importing from this module needs to change.
 */
export type { Logger, LogFields, LogLevel };

export const stderrJsonLogger = (now: () => string = () => new Date().toISOString()): Logger => ({
  log: (level, event, fields = {}) => {
    const line = JSON.stringify({ ts: now(), level, event, ...fields });
    process.stderr.write(`${line}\n`);
  },
});

/** Collects lines for assertions instead of printing them. */
export const memoryLogger = (): Logger & {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[];
} => {
  const lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  return {
    lines,
    log: (level, event, fields = {}) => {
      lines.push({ level, event, fields });
    },
  };
};

export const silentLogger: Logger = { log: () => undefined };
