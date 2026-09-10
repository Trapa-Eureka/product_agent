import { describe, expect, it } from "vitest";

import { changeTypeSchema } from "@pca/contracts";
import { nextProductionVersion } from "@pca/domain";
import { DEMO_MOVIE_IDS } from "@pca/fixtures";
import { onDay } from "@pca/test-support";

/**
 * Proves the toolchain actually resolves cross-package imports: pnpm workspace
 * links, TypeScript resolution, ESM, and Vitest all agree. A failure here means
 * the foundation is broken, not the feature under test.
 */
describe("workspace wiring", () => {
  it("resolves a real contract across a package boundary", () => {
    expect(changeTypeSchema.safeParse("CAST_UNAVAILABLE").success).toBe(true);
  });

  it("resolves the domain across a package boundary", () => {
    expect(nextProductionVersion(12)).toBe(13);
  });

  it("resolves the fixtures and test-support packages", () => {
    expect(DEMO_MOVIE_IDS.production).toBe("PROD-DEMO");
    expect(onDay("2026-09-18")).toEqual({ start: "2026-09-18", end: "2026-09-18" });
  });
});
