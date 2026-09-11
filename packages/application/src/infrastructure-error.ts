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
 * Wraps one method so a thrown error, sync or async, becomes an
 * `InfrastructureError` naming `operation`, and — with a logger — times the
 * call and logs one `db_call` line whether it succeeds or fails. Shared by
 * `guardPort` (wrapping every method of a nested port) and `guardRepositories`
 * (wrapping a `RepositorySet` member that is itself a function, such as
 * `applyProposalTransaction`, rather than a nested port object).
 */
const guardCall = (
  operation: string,
  method: (...args: unknown[]) => unknown,
  thisArg: unknown,
  logger: Logger | undefined,
): ((...args: unknown[]) => unknown) => {
  return (...args: unknown[]): unknown => {
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
      outcome = method.apply(thisArg, args);
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
    guarded[key] =
      typeof member === "function"
        ? guardCall(`${boundary}.${key}`, member as (...args: unknown[]) => unknown, port, logger)
        : member;
  }
  return guarded as Port;
};

const wrap = (boundary: string, error: unknown): InfrastructureError =>
  error instanceof InfrastructureError ? error : new InfrastructureError(boundary, error);

/**
 * Every repository in the set, guarded under `<adapter>.<repository>.<method>`.
 * A `RepositorySet` member that is itself a method (`applyProposalTransaction`,
 * TASK-901) rather than a nested port is guarded directly under
 * `<adapter>.<member>`, the same way a nested port's methods are.
 */
export const guardRepositories = <Set extends object>(
  adapter: string,
  repositories: Set,
  options: PortGuardOptions = {},
): Set => {
  const { logger } = options;
  const guarded: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(repositories)) {
    if (typeof member === "function") {
      guarded[name] = guardCall(
        `${adapter}.${name}`,
        member as (...args: unknown[]) => unknown,
        repositories,
        logger,
      );
    } else if (typeof member === "object" && member !== null) {
      guarded[name] = guardPort(`${adapter}.${name}`, member as AnyPort, options);
    } else {
      guarded[name] = member;
    }
  }
  return guarded as Set;
};
