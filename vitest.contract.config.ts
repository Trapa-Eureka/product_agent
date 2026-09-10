import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

/** MCP contract suite: tool schemas and safety boundaries (MCP.md §10). */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "contract",
      include: ["{packages,apps,tests}/**/*.contract.test.ts"],
      testTimeout: 30_000,
    },
  }),
);
