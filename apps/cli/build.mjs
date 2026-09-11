#!/usr/bin/env node
/**
 * Builds the publishable package (TASK-806): `dist/cli.js`, one ESM bundle
 * of the CLI and every workspace package it reaches, with the third-party
 * runtime dependencies (express, ws, zod, mongodb, the MCP SDK) left
 * external and declared in package.json; and `web/`, the console as
 * `@pca/web` built it. `pnpm -r build` runs this after the web build because
 * `@pca/web` is a devDependency here.
 */
import { chmod, cp, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const consoleBuild = new URL("../web/dist/browser/", import.meta.url);

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(new URL("index.html", consoleBuild)))) {
  throw new Error(
    "apps/web/dist/browser/index.html is missing: build the console first (pnpm --filter @pca/web build).",
  );
}

await rm("dist", { recursive: true, force: true });
await rm("web", { recursive: true, force: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  external: Object.keys(pkg.dependencies),
  define: { __PCA_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});
await chmod("dist/cli.js", 0o755);
await cp(consoleBuild, "web/", { recursive: true });

const bundle = await stat("dist/cli.js");
process.stdout.write(
  `production-change-agent ${pkg.version}: dist/cli.js (${Math.round(bundle.size / 1024)} kB) + web/\n`,
);
