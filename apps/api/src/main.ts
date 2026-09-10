import {
  bindQueueToJobTracker,
  createAnalyzeChangeJobHandler,
  createApplyApprovedProposal,
  createApplyProposalJobHandler,
  createJobTracker,
  createNotificationHub,
  createRunChangeAgent,
  createVerifyAppliedProposal,
  createVerifyProposalJobHandler,
  forwardJobEvents,
  randomIdFactory,
  systemClock,
  withProposalNotifications,
} from "@pca/application";
import {
  createJobRuns,
  createModelFromEnv,
  createQueue,
  createRepositoriesFromEnv,
  selectQueue,
} from "@pca/bootstrap";
import { contextFromEnv } from "@pca/mcp-server/context";

import { stderrApiLogger } from "./logging";
import { createApiServer } from "./server";

/**
 * Entry point for `production-change-agent api` (TASK-806) and direct use:
 *
 *   PCA_STORAGE=file PCA_API_PORT=3000 node --import tsx apps/api/src/main.ts
 *
 * Composition happens here and nowhere else: stores from the environment,
 * the rule-based model unless told otherwise, the in-process queue with the
 * three job handlers, the notification hub feeding the WebSocket gateway.
 */
const main = async (): Promise<void> => {
  const logger = stderrApiLogger();
  const clock = systemClock;
  const ids = randomIdFactory;
  const {
    repositories: stores,
    selection,
    close,
  } = await createRepositoriesFromEnv(process.env, {
    logger,
  });
  const hub = createNotificationHub();
  const repositories = withProposalNotifications(stores, hub, clock);
  const queueKind = selectQueue(process.env);
  const queue = createQueue(queueKind);
  const tracker = createJobTracker({ repository: createJobRuns(queueKind), clock, ids });
  forwardJobEvents(tracker, hub);
  bindQueueToJobTracker(queue, tracker);
  // No logger here: createRunChangeAgent re-guards this model with its own
  // guardModelPort call (belt-and-suspenders safety on the one path that
  // matters), and that is where the logger goes — passing it here too would
  // double-log every model call.
  const model = createModelFromEnv(process.env);

  queue.register(
    "ANALYZE_CHANGE",
    createAnalyzeChangeJobHandler({
      tracker,
      runChangeAgent: createRunChangeAgent({ repositories, model, clock, ids, logger }),
    }),
  );
  const apply = createApplyApprovedProposal({ repositories, clock, ids });
  const verify = createVerifyAppliedProposal({ repositories, clock, ids });
  queue.register("APPLY_PROPOSAL", createApplyProposalJobHandler({ tracker, apply, verify }));
  queue.register("VERIFY_PROPOSAL", createVerifyProposalJobHandler({ tracker, verify }));
  queue.start();

  const context = contextFromEnv(process.env);
  const server = createApiServer({
    repositories,
    tracker,
    queue,
    hub,
    clock,
    ids,
    context,
    logger,
  });
  const port = Number.parseInt(process.env["PCA_API_PORT"] ?? "3000", 10);
  const host = process.env["PCA_API_HOST"] ?? "127.0.0.1";
  const bound = await server.listen(port, host);
  logger.log("info", "api_start", {
    url: bound.url,
    websocket: bound.websocketUrl,
    storage: selection.kind,
    queue: queueKind,
    allowedProductions:
      context.allowedProductionIds === "*" ? "*" : context.allowedProductionIds.join(","),
  });

  const shutdown = async (): Promise<void> => {
    logger.log("info", "api_stop");
    queue.stop();
    await server.close();
    await close();
  };
  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "api_crash", error: String(error) })}\n`,
  );
  process.exit(1);
});
