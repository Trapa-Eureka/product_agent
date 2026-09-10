import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { randomIdFactory, systemClock } from "@pca/application";
import { createRepositoriesFromEnv } from "@pca/bootstrap";

import { contextFromEnv } from "./context";
import { createAllToolHandlers } from "./handlers";
import { stderrJsonLogger } from "./logging";
import { createProductionChangeServer } from "./server";

/**
 * Entry point for `production-change-agent mcp` (TASK-806) and for direct use:
 *
 *   PCA_STORAGE=file PCA_ALLOWED_PRODUCTIONS=PROD-DEMO node --import tsx apps/mcp-server/src/main.ts
 *
 * stdout is the protocol stream; everything human-readable goes to stderr.
 */
const main = async (): Promise<void> => {
  const logger = stderrJsonLogger();
  const { repositories, selection, close } = await createRepositoriesFromEnv(process.env);
  const context = contextFromEnv(process.env);

  // Tool handlers are wired here as they land (analysis, proposal, write, verify follow).
  const { server, registeredTools } = createProductionChangeServer({
    handlers: createAllToolHandlers({ repositories, clock: systemClock, ids: randomIdFactory }),
    context,
    logger,
  });

  logger.log("info", "server_start", {
    storage: selection.kind,
    actor: context.actor.id,
    allowedProductions:
      context.allowedProductionIds === "*" ? "*" : context.allowedProductionIds.join(","),
    tools: registeredTools.length,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    logger.log("info", "server_stop");
    await server.close();
    await close();
  };
  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "server_crash", error: String(error) })}\n`,
  );
  process.exit(1);
});
