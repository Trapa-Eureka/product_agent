import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SPECIALISED_SUITES } from "../vitest.shared.js";

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")) as Record<
    string,
    unknown
  >;

const rootPackageJson = readJson("../package.json");
const tsconfigBase = readJson("../tsconfig.base.json");

/**
 * The commands and compiler settings below are a contract with CLAUDE.md
 * ("Target root commands") and TESTING.md §10-11. Agents rely on them existing
 * and on strict mode being non-negotiable, so both are asserted rather than
 * documented and hoped for.
 */
describe("tooling contract", () => {
  const scripts = rootPackageJson["scripts"] as Record<string, string>;

  it.each(["typecheck", "lint", "test", "test:integration", "test:contract", "test:e2e", "verify"])(
    "exposes the root command %s",
    (command) => {
      expect(scripts[command]).toBeTypeOf("string");
    },
  );

  it("keeps TypeScript strict mode enabled", () => {
    const compilerOptions = tsconfigBase["compilerOptions"] as Record<string, unknown>;
    expect(compilerOptions["strict"]).toBe(true);
    expect(compilerOptions["noUncheckedIndexedAccess"]).toBe(true);
  });

  it("declares a dedicated runner for every specialised suite", () => {
    for (const suite of SPECIALISED_SUITES) {
      expect(scripts[`test:${suite}`]).toBeTypeOf("string");
    }
  });
});
