import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

/** Integration suite: application use cases against real adapters (TESTING.md §2). */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "integration",
      include: ["{packages,apps,tests}/**/*.integration.test.ts"],
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
