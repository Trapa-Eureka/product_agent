import { describe, expect, it } from "vitest";

import { correlationIdSchema, entityIdSchema } from "@pca/contracts";

import { randomIdFactory } from "../src";

/** TASK-932 (AUD-025): generated IDs carry the whole UUID's entropy and fit every contract. */
describe("randomIdFactory", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

  it("emits <prefix>-<uuid v4>: 122 random bits, never truncated", () => {
    const id = randomIdFactory.next("P");
    expect(id.startsWith("P-")).toBe(true);
    expect(id.slice(2)).toMatch(UUID_V4);
    expect(id).toHaveLength(2 + 36);
  });

  it("satisfies the entity and correlation ID contracts with the prefixes in use", () => {
    for (const prefix of ["P", "A", "AE", "CR", "JOB", "corr"]) {
      const id = randomIdFactory.next(prefix);
      expect(entityIdSchema.safeParse(id).success).toBe(true);
      expect(correlationIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("does not repeat across many draws", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) seen.add(randomIdFactory.next("X"));
    expect(seen.size).toBe(10_000);
  });
});
