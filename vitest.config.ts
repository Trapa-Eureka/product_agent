import { defineConfig, mergeConfig } from "vitest/config";
import { SPECIALISED_SUITES, sharedTestConfig } from "./vitest.shared.js";

/** Unit suite: every *.test.ts that is not claimed by a specialised suite. */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "unit",
      include: ["{packages,apps,tests}/**/*.test.ts"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        ...SPECIALISED_SUITES.map((suite) => `**/*.${suite}.test.ts`),
      ],
    },
  }),
);
