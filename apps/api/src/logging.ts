/** Structured JSON lines on stderr, the same shape the MCP server uses. */
export type ApiLogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface ApiLogger {
  log(level: "info" | "warn" | "error", event: string, fields?: ApiLogFields): void;
}

export const stderrApiLogger = (now: () => string = () => new Date().toISOString()): ApiLogger => ({
  log: (level, event, fields = {}) => {
    process.stderr.write(`${JSON.stringify({ ts: now(), level, event, ...fields })}\n`);
  },
});

export const silentApiLogger: ApiLogger = { log: () => undefined };
