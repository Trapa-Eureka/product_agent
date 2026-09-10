import { describe, expect, it } from "vitest";

import { changeTypeSchema } from "@pca/contracts";
import { PACKAGE_NAME as domain } from "@pca/domain";
import { PACKAGE_NAME as fixtures } from "@pca/fixtures";
import { PACKAGE_NAME as testSupport } from "@pca/test-support";

/**
 * Proves the toolchain actually resolves cross-package imports: pnpm workspace
 * links, TypeScript resolution, ESM, and Vitest all agree. A failure here means
 * the foundation is broken, not the feature under test.
 */
describe("workspace wiring", () => {
  it("resolves a real contract across a package boundary", () => {
    expect(changeTypeSchema.safeParse("CAST_UNAVAILABLE").success).toBe(true);
  });

  it("resolves the packages still awaiting implementation", () => {
    expect([domain, fixtures, testSupport]).toEqual([
      "@pca/domain",
      "@pca/fixtures",
      "@pca/test-support",
    ]);
  });
});
