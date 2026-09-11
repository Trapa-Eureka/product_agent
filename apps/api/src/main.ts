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
  reconcileInterruptedRuns,
  systemClock,
  withProposalNotifications,
} from "@pca/application";
import {
  createJobRuns,
  createModelFromEnv,
  createQueue,
  createRepositoriesFromEnv,
  selectAuth,
  selectQueue,
} from "@pca/bootstrap";
import { contextFromEnv } from "@pca/mcp-server/context";

import { DEFAULT_REQUESTS_PER_MINUTE, DEFAULT_WRITES_PER_MINUTE } from "./app";
import { stderrApiLogger } from "./logging";
import { allowedOriginsFromEnv } from "./origins";
import { createApiServer } from "./server";

const isTrueEnv = (value: string | undefined): boolean => value?.trim().toLowerCase() === "true";

/** A positive integer from the environment, or the default; anything else refuses to start. */
const positiveIntFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`${name}="${raw}" must be a positive integer (requests per minute).`);
  }
  return value;
};

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
  const storage = await createRepositoriesFromEnv(process.env, { logger });
  const { repositories: stores, selection, close } = storage;
  const hub = createNotificationHub();
  const repositories = withProposalNotifications(stores, hub, clock);
  const queueKind = selectQueue(process.env);
  const queue = createQueue(queueKind);
  const jobRuns = createJobRuns(queueKind, storage);
  const tracker = createJobTracker({ repository: jobRuns, clock, ids });
  forwardJobEvents(tracker, hub);
  // TASK-923: with durable runs, the ones a restart interrupted are failed
  // with a reason rather than left "in progress" forever; runs waiting on a
  // human (resolving, awaiting_approval) are kept.
  await reconcileInterruptedRuns({ tracker, repository: jobRuns, logger });
  bindQueueToJobTracker(queue, tracker, { logger });
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
  // Identity (TASK-914): a signed-token deployment, or an explicit demo. Neither: refuse to start.
  const auth = selectAuth(process.env, clock);
  // Browser origins that may open the socket (TASK-916): the operator's list, or the dev UI in demo mode.
  const allowedOrigins = allowedOriginsFromEnv(process.env, auth.mode);
  const limits = {
    requestsPerMinute: positiveIntFromEnv("PCA_RATE_LIMIT_PER_MINUTE", DEFAULT_REQUESTS_PER_MINUTE),
    writesPerMinute: positiveIntFromEnv("PCA_WRITE_LIMIT_PER_MINUTE", DEFAULT_WRITES_PER_MINUTE),
  };
  const server = createApiServer({
    repositories,
    tracker,
    queue,
    hub,
    clock,
    ids,
    context,
    limits,
    tlsTerminated: isTrueEnv(process.env["PCA_TLS_TERMINATED"]),
    probeStore: storage.probe,
    identity: auth.identity,
    ...(auth.demoSession === undefined ? {} : { demoSession: auth.demoSession }),
    makerChecker: auth.makerChecker,
    allowedOrigins,
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
    auth: auth.mode,
    makerChecker: auth.makerChecker,
    allowedOrigins: allowedOrigins.join(",") || "(same-origin only)",
    requestsPerMinute: limits.requestsPerMinute,
    writesPerMinute: limits.writesPerMinute,
    hsts: isTrueEnv(process.env["PCA_TLS_TERMINATED"]),
    allowedProductions:
      context.allowedProductionIds === "*" ? "*" : context.allowedProductionIds.join(","),
  });

  if (auth.mode === "demo") {
    logger.log("warn", "auth_demo_mode", {
      message:
        "PCA_DEMO_MODE=true: anyone who can reach this server can obtain the demo coordinator's token from GET /api/auth/demo-session. Set PCA_AUTH_SECRET for a deployment.",
    });
  }

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
