/**
 * Structured logging for the MCP server (SPEC.md §8 Observability).
 *
 * Lines go to stderr as JSON, never to stdout: stdout is the stdio transport,
 * and a stray log line there corrupts the protocol stream. Each tool call logs
 * its name, correlation ID, duration, and outcome or error code, and nothing
 * else. No prompt text, no chain-of-thought, no entity payloads.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

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
