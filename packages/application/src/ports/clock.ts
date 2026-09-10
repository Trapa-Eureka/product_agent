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
  /** A new identifier such as `CR-3f9a1c2b`, unique within the prefix. */
  next(prefix: string): EntityId;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const randomIdFactory: IdFactory = {
  next: (prefix) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
};
