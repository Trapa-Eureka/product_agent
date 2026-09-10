import type { Clock, IdFactory } from "@pca/application";
import type { IsoDateTime } from "@pca/contracts";

/**
 * Deterministic time and identity for tests.
 *
 * With these injected, a test can assert the exact change request or audit
 * event a use case wrote, including its ID and timestamp, instead of matching
 * on "some string" and hoping.
 */

/** A clock that reports one instant until told to advance. */
export const fixedClock = (
  start: IsoDateTime = "2026-09-10T11:03:00.000Z",
): Clock & {
  advance(milliseconds: number): void;
} => {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current).toISOString(),
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
};

/** IDs such as `CR-1`, `CR-2`, `P-1`, counted per prefix in call order. */
export const sequentialIds = (): IdFactory => {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const value = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, value);
      return `${prefix}-${value}`;
    },
  };
};
