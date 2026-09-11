import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `production-change-agent` (TASK-806): one package, one command, three
 * subcommands, and no paid service. Everything below is the same code the
 * repository runs (`apps/api/src/main.ts`, `apps/mcp-server/src/main.ts`,
 * `resetDemoMovie`), bundled by `build.mjs` so a clean machine needs only
 * Node and this package.
 *
 *   npx production-change-agent seed    # restore the Demo Movie into the file store
 *   npx production-change-agent serve   # console + REST API + WebSocket on one port
 *   npx production-change-agent mcp     # stdio MCP server over the same file store
 *
 * Defaults are the free ones (`PCA_STORAGE=file`, `PCA_MODEL=rules`, the
 * in-process queue); every environment variable in README.md still applies.
 * With neither `PCA_AUTH_SECRET` nor `PCA_DEMO_MODE` set, `serve` and `mcp`
 * run as the local demo (`PCA_DEMO_MODE=true`) and say so, because a first
 * `npx` must start; a deployment sets the secret and gets the real thing.
 */

declare const __PCA_VERSION__: string;

const USAGE = `production-change-agent ${__PCA_VERSION__}

Usage: production-change-agent <command>

  seed    Restore the Demo Movie fixture into the file store (PCA_DATA_FILE).
  serve   Serve the console, the REST API, and the WebSocket on one port
          (PCA_API_HOST, PCA_API_PORT; default http://127.0.0.1:3000).
  mcp     Run the MCP server over stdio for an agent host.

Defaults need no account or service: a JSON file store under
~/.production-change-agent, the rule-based interpreter, an in-process queue.
Set PCA_AUTH_SECRET for a deployment; without it, serve and mcp run as the
local demo (PCA_DEMO_MODE=true). Full reference: README.md "Runtime environment".
`;

const note = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The demo unless the operator configured identity: a first `npx` must start. */
const applyDemoDefault = (): void => {
  const env = process.env;
  const secret = env["PCA_AUTH_SECRET"]?.trim() ?? "";
  const demo = env["PCA_DEMO_MODE"]?.trim() ?? "";
  if (secret === "" && demo === "") {
    env["PCA_DEMO_MODE"] = "true";
    note(
      "production-change-agent: PCA_AUTH_SECRET is not set, so this is the local demo (PCA_DEMO_MODE=true): anyone who can reach the port acts as the demo coordinator. Set PCA_AUTH_SECRET for a deployment.",
    );
  }
};

/** The console shipped in the package, beside `dist/`; served unless the operator points elsewhere. */
const applyConsoleDefault = (): void => {
  const env = process.env;
  if ((env["PCA_CONSOLE_DIR"]?.trim() ?? "") !== "") return;
  const shipped = fileURLToPath(new URL("../web/", import.meta.url));
  if (existsSync(join(shipped, "index.html"))) {
    env["PCA_CONSOLE_DIR"] = shipped;
  } else {
    note(
      `production-change-agent: no console found at ${shipped}; serving the API only. Set PCA_CONSOLE_DIR to a built console to serve one.`,
    );
  }
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? "";
  switch (command) {
    case "seed": {
      const { resetDemoMovie } = await import("@pca/bootstrap");
      const result = await resetDemoMovie(process.env);
      process.stdout.write(
        `Demo Movie restored: production ${result.productionId} at ${result.filePath}\n`,
      );
      return;
    }
    case "serve": {
      applyDemoDefault();
      applyConsoleDefault();
      await import("@pca/api/main");
      return;
    }
    case "mcp": {
      applyDemoDefault();
      await import("@pca/mcp-server/main");
      return;
    }
    case "--version":
    case "-v":
      process.stdout.write(`${__PCA_VERSION__}\n`);
      return;
    case "--help":
    case "-h":
    case "help":
    case "":
      process.stdout.write(USAGE);
      process.exitCode = command === "" ? 2 : 0;
      return;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 2;
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
