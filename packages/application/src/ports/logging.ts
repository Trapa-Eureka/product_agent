/**
 * The logger port (TASK-804, ARCHITECTURE.md §16 "Observability").
 *
 * One structured line per event, the same shape `apps/api` and
 * `apps/mcp-server` already log with (JSON on stderr: an event name, flat
 * fields, nothing else — no prompt text, no entity payloads). Promoted here,
 * rather than left duplicated in each app, so `packages/application` and
 * `packages/adapters/*` can log through it too: `guardPort`/`guardRepositories`
 * (correlation IDs and timing for every repository call) and
 * `guardModelPort` (the same for a model call) both take one.
 *
 * Framework-independent by construction: it is an interface with no
 * transport opinion, so depending on it does not cost `packages/application`
 * its "no HTTP server, no database driver, no model SDK" rule.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

/** The default for a caller that does not want logging — never `undefined` checks at every call site. */
export const silentLogger: Logger = { log: () => undefined };
