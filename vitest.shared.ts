import type { ViteUserConfig } from "vitest/config";

/** Test-file suffixes that belong to a dedicated suite, not the unit suite. */
export const SPECIALISED_SUITES = ["integration", "contract", "e2e"] as const;

export const sharedTestConfig: ViteUserConfig = {
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: true,
    restoreMocks: true,
    unstubEnvs: true,
    include: [],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
