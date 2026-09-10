/**
 * Fault injection for ports (TESTING.md §8, TASK-602).
 *
 * `withFault` returns a copy of a port whose one method fails as scripted:
 * always, or for the first `times` calls and then normally. The original is
 * untouched, so the same store can be healthy in one test and failing in the
 * next without rebuilding fixtures.
 */

export type Fault = {
  /** The error to throw (async methods reject with it). */
  readonly error: Error;
  /** How many calls fail before the method behaves normally. Omit for "always". */
  readonly times?: number;
};

export type FaultHandle = {
  /** Calls that failed so far. */
  readonly failures: () => number;
};

export const withFault = <Port extends object, Method extends keyof Port>(
  port: Port,
  method: Method,
  fault: Fault,
): Port & FaultHandle => {
  let failures = 0;
  const original = port[method] as unknown as (...args: unknown[]) => unknown;
  const failing = (...args: unknown[]): unknown => {
    if (fault.times === undefined || failures < fault.times) {
      failures += 1;
      return Promise.reject(fault.error);
    }
    return original.apply(port, args);
  };
  return {
    ...port,
    [method]: failing,
    failures: () => failures,
  };
};

/** A repository set with one repository's method failing; the rest untouched. */
export const withRepositoryFault = <
  Set extends Record<Name, object>,
  Name extends keyof Set & string,
  Method extends keyof Set[Name],
>(
  repositories: Set,
  name: Name,
  method: Method,
  fault: Fault,
): Set & { readonly fault: FaultHandle } => {
  const faulty = withFault(repositories[name], method, fault);
  return { ...repositories, [name]: faulty, fault: faulty };
};
