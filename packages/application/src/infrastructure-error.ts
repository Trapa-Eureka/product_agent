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

/**
 * Wraps every method of a port so a thrown error, sync or async, becomes an
 * `InfrastructureError` naming `<boundary>.<method>`. Values are returned
 * untouched; expected failures a port returns as values are not errors.
 */
export const guardPort = <Port extends AnyPort>(boundary: string, port: Port): Port => {
  const guarded: Record<string, unknown> = {};
  for (const key of Object.keys(port) as (keyof Port & string)[]) {
    const member = port[key];
    if (typeof member !== "function") {
      guarded[key] = member;
      continue;
    }
    const method = member as (...args: unknown[]) => unknown;
    guarded[key] = (...args: unknown[]): unknown => {
      let outcome: unknown;
      try {
        outcome = method.apply(port, args);
      } catch (error) {
        throw wrap(`${boundary}.${key}`, error);
      }
      if (outcome instanceof Promise) {
        return outcome.catch((error: unknown) => {
          throw wrap(`${boundary}.${key}`, error);
        });
      }
      return outcome;
    };
  }
  return guarded as Port;
};

const wrap = (boundary: string, error: unknown): InfrastructureError =>
  error instanceof InfrastructureError ? error : new InfrastructureError(boundary, error);

/** Every repository in the set, guarded under `<adapter>.<repository>.<method>`. */
export const guardRepositories = <Set extends object>(adapter: string, repositories: Set): Set => {
  const guarded: Record<string, unknown> = {};
  for (const [name, repository] of Object.entries(repositories)) {
    guarded[name] =
      typeof repository === "object" && repository !== null
        ? guardPort(`${adapter}.${name}`, repository as AnyPort)
        : repository;
  }
  return guarded as Set;
};
