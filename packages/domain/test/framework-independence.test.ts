import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The domain's defining constraint, checked directly rather than trusted.
 *
 * ESLint enforces a deny-list of known infrastructure packages. This test takes
 * the opposite and stricter position: an allow-list. Anything the domain imports
 * that is not a relative module, a Node builtin, or the shared contracts package
 * fails here, including a dependency nobody thought to add to the deny-list.
 */

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

const ALLOWED_PACKAGE_IMPORTS = new Set(["@pca/contracts", "node:crypto"]);

const IMPORT_PATTERN = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gmu;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });

const importsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? "");
};

describe("domain framework independence", () => {
  const files = sourceFiles(SRC_DIR);

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(SRC_DIR.length + 1), file]))(
    "%s imports nothing outside the allow-list",
    (_name, file) => {
      const external = importsOf(file).filter((specifier) => !specifier.startsWith("."));
      for (const specifier of external) {
        expect(
          ALLOWED_PACKAGE_IMPORTS.has(specifier),
          `${specifier} is not allowed in the domain. Depend on a port instead (ARCHITECTURE.md §6).`,
        ).toBe(true);
      }
    },
  );

  it("keeps the allow-list small and deliberate", () => {
    expect([...ALLOWED_PACKAGE_IMPORTS].sort()).toEqual(["@pca/contracts", "node:crypto"]);
  });
});
