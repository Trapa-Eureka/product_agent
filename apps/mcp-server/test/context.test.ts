import { describe, expect, it } from "vitest";

import { contextFromEnv } from "../src/context";

/**
 * TASK-906: the actor the server records in every approval and audit event
 * is validated where it is admitted (the environment), against the same
 * limit the persisted records enforce.
 */
const DEMO = { PCA_DEMO_MODE: "true" };

describe("contextFromEnv", () => {
  it("defaults the actor and accepts a valid PCA_ACTOR_ID", () => {
    expect(contextFromEnv(DEMO).actor).toEqual({ type: "AGENT", id: "mcp-agent" });
    expect(contextFromEnv({ ...DEMO, PCA_ACTOR_ID: "agent@example.test" }).actor.id).toBe(
      "agent@example.test",
    );
  });

  it("refuses an actor ID the persisted records could not hold, at startup", () => {
    expect(() => contextFromEnv({ ...DEMO, PCA_ACTOR_ID: "a".repeat(201) })).toThrow(
      /PCA_ACTOR_ID/u,
    );
    expect(() => contextFromEnv({ ...DEMO, PCA_ACTOR_ID: "" })).toThrow(/PCA_ACTOR_ID/u);
  });

  /**
   * TASK-915 (SEC-002 / AUD-003): a missing allow-list used to mean every
   * production. Now it means no server, unless the environment says demo.
   */
  describe("allow-list fails closed", () => {
    it("refuses to start with the allow-list unset, blank, or `*` outside demo mode", () => {
      for (const env of [{}, { PCA_ALLOWED_PRODUCTIONS: "" }, { PCA_ALLOWED_PRODUCTIONS: " , " }]) {
        expect(() => contextFromEnv(env)).toThrow(/PCA_ALLOWED_PRODUCTIONS is not set/u);
      }
      expect(() => contextFromEnv({ PCA_ALLOWED_PRODUCTIONS: "*" })).toThrow(
        /PCA_ALLOWED_PRODUCTIONS is "\*"/u,
      );
      expect(() =>
        contextFromEnv({ PCA_ALLOWED_PRODUCTIONS: "*", PCA_DEMO_MODE: "false" }),
      ).toThrow(/PCA_DEMO_MODE=true/u);
    });

    it("grants every production only when PCA_DEMO_MODE=true says so", () => {
      expect(contextFromEnv(DEMO).allowedProductionIds).toBe("*");
      expect(contextFromEnv({ ...DEMO, PCA_ALLOWED_PRODUCTIONS: "*" }).allowedProductionIds).toBe(
        "*",
      );
      expect(contextFromEnv({ PCA_DEMO_MODE: " TRUE " }).allowedProductionIds).toBe("*");
    });

    it("parses a list and keeps it even in demo mode", () => {
      expect(
        contextFromEnv({ PCA_ALLOWED_PRODUCTIONS: " PROD-DEMO , PROD-2 ,, " }).allowedProductionIds,
      ).toEqual(["PROD-DEMO", "PROD-2"]);
      expect(
        contextFromEnv({ ...DEMO, PCA_ALLOWED_PRODUCTIONS: "PROD-DEMO" }).allowedProductionIds,
      ).toEqual(["PROD-DEMO"]);
    });

    it("refuses an entry that is not a valid production ID, naming it", () => {
      expect(() =>
        contextFromEnv({ PCA_ALLOWED_PRODUCTIONS: `PROD-DEMO,${"x".repeat(129)}` }),
      ).toThrow(/entry "x{129}" is not a valid production ID/u);
      expect(() =>
        contextFromEnv({ ...DEMO, PCA_ALLOWED_PRODUCTIONS: "PROD-DEMO,bad id" }),
      ).toThrow(/entry "bad id"/u);
    });
  });
});
