/**
 * The API server Playwright's E2E suite (TASK-604) drives the browser
 * against.
 *
 * This is the same composition `../src/main.ts` uses for a real deployment
 * — the rule-based model, the in-process queue, the three job handlers, the
 * notification hub feeding the WebSocket gateway — pointed at a memory
 * store instead of Mongo, so the suite runs with no external service and no
 * AWS account (the free-first constraint). What only exists here is the
 * seed: three independent copies of the Demo Movie fixture, one per golden
 * scenario, so GOLDEN-1/2/3 can run against the same server process without
 * one scenario's mutation (Friday's scenes moving to Monday) breaking the
 * next scenario's preconditions.
 *
 * Run directly with `tsx` (playwright.config.ts's `webServer`); never
 * imported.
 */
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
  guardModelPort,
  guardRepositories,
  randomIdFactory,
  systemClock,
  withProposalNotifications,
} from "@pca/application";
import { selectAuth } from "@pca/bootstrap";
import { createDemoMovie, type DemoMovieFixture } from "@pca/fixtures";
import { createMemoryJobRunRepository, createMemoryQueue } from "@pca/memory-queue";
import { createMemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";

import { stderrApiLogger } from "../src/logging";
import { allowedOriginsFromEnv } from "../src/origins";
import { createApiServer } from "../src/server";

/**
 * The three productions GOLDEN-1/2/3 each get their own copy of (TESTING.md
 * §4): a full Demo Movie fixture, renamed. Entity IDs (`S07`, `CAST-SARAH`,
 * ...) stay identical across the three — productions are their own
 * namespace (ARCHITECTURE.md, "keeps two productions apart") — only the
 * production ID and every entity's `productionId` foreign key change.
 */
export const E2E_PRODUCTION_IDS = {
  goldenSarah: "PROD-E2E-1",
  goldenWarehouse: "PROD-E2E-2",
  goldenRedCar: "PROD-E2E-3",
} as const;

const withProductionId = (fixture: DemoMovieFixture, id: string): DemoMovieFixture => ({
  production: { ...fixture.production, id },
  scenes: fixture.scenes.map((entity) => ({ ...entity, productionId: id })),
  castMembers: fixture.castMembers.map((entity) => ({ ...entity, productionId: id })),
  locations: fixture.locations.map((entity) => ({ ...entity, productionId: id })),
  requirements: fixture.requirements.map((entity) => ({ ...entity, productionId: id })),
  shootDays: fixture.shootDays.map((entity) => ({ ...entity, productionId: id })),
  callSheets: fixture.callSheets.map((entity) => ({ ...entity, productionId: id })),
  tasks: fixture.tasks.map((entity) => ({ ...entity, productionId: id })),
});

const main = async (): Promise<void> => {
  const logger = stderrApiLogger();
  const clock = systemClock;
  const ids = randomIdFactory;

  const store = createMemoryStore({ now: () => clock.now() });
  for (const productionId of Object.values(E2E_PRODUCTION_IDS)) {
    await store.productions.save(withProductionId(createDemoMovie(), productionId));
  }

  const hub = createNotificationHub();
  const repositories = withProposalNotifications(
    guardRepositories("memory", store, { logger }),
    hub,
    clock,
  );
  const queue = createMemoryQueue({ clock, ids });
  const tracker = createJobTracker({ repository: createMemoryJobRunRepository(), clock, ids });
  forwardJobEvents(tracker, hub);
  bindQueueToJobTracker(queue, tracker, { logger });
  const model = guardModelPort(createRuleModelAdapter(), { logger });

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

  // Demo identity (TASK-914): the browser fetches the demo coordinator's
  // token from /api/auth/demo-session exactly as `npx … serve` users do, so
  // the E2E suite exercises the real bearer-token path with no secret to
  // configure. Every REST call and approval is recorded as that principal.
  const auth = selectAuth({ PCA_DEMO_MODE: "true" }, clock);
  const server = createApiServer({
    repositories,
    tracker,
    queue,
    hub,
    clock,
    ids,
    // Every production this script just seeded is on the allow-list;
    // nothing outside it exists to protect (local E2E only, never a
    // deployment's context).
    context: { actor: { type: "USER", id: "e2e" }, allowedProductionIds: "*" },
    identity: auth.identity,
    ...(auth.demoSession === undefined ? {} : { demoSession: auth.demoSession }),
    makerChecker: auth.makerChecker,
    // The browser's page comes from the Angular dev server on 4200 (TASK-916).
    allowedOrigins: allowedOriginsFromEnv({}, auth.mode),
    logger,
  });
  const bound = await server.listen(3000, "127.0.0.1");
  logger.log("info", "e2e_api_start", {
    url: bound.url,
    websocket: bound.websocketUrl,
    productions: Object.values(E2E_PRODUCTION_IDS).join(","),
  });

  const shutdown = async (): Promise<void> => {
    logger.log("info", "e2e_api_stop");
    queue.stop();
    await server.close();
  };
  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "e2e_api_crash", error: String(error) })}\n`,
  );
  process.exit(1);
});
