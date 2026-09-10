import type { Logger } from "./ports/logging";

/**
 * Infrastructure failures, named (TASK-602, TESTING.md §8).
 *
 * A use case returns expected failures as values. What it throws is an
 * infrastructure fault: a store that cannot be reached, a driver that gave
 * up. Those must still be legible when they surface in a queue retry
 * reason, a job run message, an MCP tool error, or a log line, so every
 * port is wrapped by `guardPort`, which turns a thrown error into an
 * `InfrastructureError` that names the boundary (`mongo.productions.commit`)
 * and keeps the cause. The reporting point adds the correlation ID it knows.
 *
 * `guardPort` also logs one `db_call` line per call (TASK-804, ARCHITECTURE.md
 * §16): the boundary, `durationMs`, and whether it succeeded — with an
 * optional `Logger`, since most callers (every unit/integration test) do
 * not want one.
 */

export class InfrastructureError extends Error {
  readonly code = "INFRASTRUCTURE_FAILURE";

  constructor(
    /** `<adapter>.<port>.<operation>`, e.g. `mongo.productions.commit`. */
    readonly boundary: string,
    override readonly cause: unknown,
    readonly correlationId?: string,
  ) {
    super(
      `${boundary} failed: ${messageOf(cause)}${
        correlationId === undefined ? "" : ` (correlation ${correlationId})`
      }`,
    );
    this.name = "InfrastructureError";
  }

  /** The same failure, now attributed to the request it happened in. */
  withCorrelation(correlationId: string): InfrastructureError {
    return new InfrastructureError(this.boundary, this.cause, correlationId);
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * One line for a report: boundary and cause for an infrastructure failure,
 * the message for anything else, and the correlation ID in both cases.
 */
export const describeFailure = (error: unknown, correlationId?: string): string => {
  if (error instanceof InfrastructureError) {
    return correlationId === undefined || error.correlationId === correlationId
      ? error.message
      : error.withCorrelation(correlationId).message;
  }
  return `${messageOf(error)}${correlationId === undefined ? "" : ` (correlation ${correlationId})`}`;
};

type AnyPort = object;

export type PortGuardOptions = {
  /** Logs one `db_call` line per method call: boundary, durationMs, outcome. */
  readonly logger?: Logger;
};

/**
 * Wraps every method of a port so a thrown error, sync or async, becomes an
 * `InfrastructureError` naming `<boundary>.<method>`. Values are returned
 * untouched; expected failures a port returns as values are not errors.
 * With a logger, also times every call, success or failure alike.
 */
export const guardPort = <Port extends AnyPort>(
  boundary: string,
  port: Port,
  options: PortGuardOptions = {},
): Port => {
  const { logger } = options;
  const guarded: Record<string, unknown> = {};
  for (const key of Object.keys(port) as (keyof Port & string)[]) {
    const member = port[key];
    if (typeof member !== "function") {
      guarded[key] = member;
      continue;
    }
    const method = member as (...args: unknown[]) => unknown;
    const operation = `${boundary}.${key}`;
    guarded[key] = (...args: unknown[]): unknown => {
      const startedAt = Date.now();
      const record = (callOutcome: "ok" | "error"): void => {
        logger?.log("info", "db_call", {
          boundary: operation,
          outcome: callOutcome,
          durationMs: Date.now() - startedAt,
        });
      };
      let outcome: unknown;
      try {
        outcome = method.apply(port, args);
      } catch (error) {
        record("error");
        throw wrap(operation, error);
      }
      if (outcome instanceof Promise) {
        return outcome.then(
          (value: unknown) => {
            record("ok");
            return value;
          },
          (error: unknown) => {
            record("error");
            throw wrap(operation, error);
          },
        );
      }
      record("ok");
      return outcome;
    };
  }
  return guarded as Port;
};

const wrap = (boundary: string, error: unknown): InfrastructureError =>
  error instanceof InfrastructureError ? error : new InfrastructureError(boundary, error);

/** Every repository in the set, guarded under `<adapter>.<repository>.<method>`. */
export const guardRepositories = <Set extends object>(
  adapter: string,
  repositories: Set,
  options: PortGuardOptions = {},
): Set => {
  const guarded: Record<string, unknown> = {};
  for (const [name, repository] of Object.entries(repositories)) {
    guarded[name] =
      typeof repository === "object" && repository !== null
        ? guardPort(`${adapter}.${name}`, repository as AnyPort, options)
        : repository;
  }
  return guarded as Set;
};
