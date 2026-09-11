import { describe, expect, it } from "vitest";

import { contextFromEnv } from "../src/context";

/**
 * TASK-906: the actor the server records in every approval and audit event
 * is validated where it is admitted (the environment), against the same
 * limit the persisted records enforce.
 */
describe("contextFromEnv", () => {
  it("defaults the actor and accepts a valid PCA_ACTOR_ID", () => {
    expect(contextFromEnv({}).actor).toEqual({ type: "AGENT", id: "mcp-agent" });
    expect(contextFromEnv({ PCA_ACTOR_ID: "agent@example.test" }).actor.id).toBe(
      "agent@example.test",
    );
  });

  it("refuses an actor ID the persisted records could not hold, at startup", () => {
    expect(() => contextFromEnv({ PCA_ACTOR_ID: "a".repeat(201) })).toThrow(/PCA_ACTOR_ID/u);
    expect(() => contextFromEnv({ PCA_ACTOR_ID: "" })).toThrow(/PCA_ACTOR_ID/u);
  });
});
