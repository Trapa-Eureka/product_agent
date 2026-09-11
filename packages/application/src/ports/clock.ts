import { randomUUID } from "node:crypto";

import type { EntityId, IsoDateTime } from "@pca/contracts";

/**
 * Time and identity are ports.
 *
 * A use case that calls `new Date()` or generates its own IDs cannot be tested
 * for an exact audit trail. Behind a port, a test injects a fixed clock and a
 * counting ID factory and asserts the precise record that was written.
 */

export interface Clock {
  now(): IsoDateTime;
}

export interface IdFactory {
  /** A new identifier such as `CR-6f1c…-…`, unique within the prefix. */
  next(prefix: string): EntityId;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/**
 * TASK-932 (AUD-025): the whole UUID v4 — 122 random bits — not its first
 * 48. Proposal, approval, job, audit, and correlation IDs are long-lived
 * operational records that get quoted in tokens, logs, and audit lines; an
 * ID that is cheap to guess or to collide is a weakness there, and the 36
 * characters fit every ID contract (`entityIdSchema` allows 128).
 */
export const randomIdFactory: IdFactory = {
  next: (prefix) => `${prefix}-${randomUUID()}`,
};
