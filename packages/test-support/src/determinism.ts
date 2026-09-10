import type { Clock, IdFactory, Scheduler } from "@pca/application";
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

/**
 * A scheduler that holds time still. Tasks run only when the test says so,
 * so a retry backoff is an assertion about a recorded delay, not a sleep.
 */
export type ManualScheduler = Scheduler & {
  /** Delays requested so far, in order, cancelled ones included. */
  readonly delays: number[];
  /** Number of tasks waiting. */
  pending(): number;
  /** Runs the earliest-scheduled waiting task. Returns false when none is waiting. */
  runNext(): boolean;
  /** Runs waiting tasks until none is left, including ones scheduled meanwhile. */
  runAll(): number;
};

export const manualScheduler = (): ManualScheduler => {
  const queue: { id: number; task: () => void }[] = [];
  const delays: number[] = [];
  let sequence = 0;
  return {
    delays,
    schedule(task, delayMs) {
      const id = (sequence += 1);
      delays.push(delayMs);
      queue.push({ id, task });
      return () => {
        const index = queue.findIndex((entry) => entry.id === id);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    pending: () => queue.length,
    runNext() {
      const next = queue.shift();
      if (next === undefined) return false;
      next.task();
      return true;
    },
    runAll() {
      let ran = 0;
      while (this.runNext()) ran += 1;
      return ran;
    },
  };
};
