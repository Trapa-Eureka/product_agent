import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type {
  ApplyApprovedProposal,
  Clock,
  DecideProposal,
  GetJobRun,
  GetRecoverySnapshot,
  IdFactory,
  JobTracker,
  QueuePort,
  RepositorySet,
  UseCaseResult,
} from "@pca/application";
import {
  createApplyApprovedProposal,
  createDecideProposal,
  createGetJobRun,
  createGetRecoverySnapshot,
  createSubmitChangeRequest,
} from "@pca/application";
import type { EntityId, ToolError } from "@pca/contracts";
import {
  approvalDecisionSchema,
  entityIdSchema,
  proposalStatusSchema,
  typedChangeSchema,
} from "@pca/contracts";
import type { ServerContext } from "@pca/mcp-server/context";
import { authorize } from "@pca/mcp-server/context";
import type { CallContext, ToolHandlers } from "@pca/mcp-server/handlers";
import { createAllToolHandlers } from "@pca/mcp-server/handlers";

import { HTTP_STATUS_BY_CODE, invalidInput, sendError } from "./errors";
import { invokeTool } from "./invoke";
import type { ApiLogger } from "./logging";
import { silentApiLogger } from "./logging";

/**
 * The REST API (TASK-110, ARCHITECTURE.md §6).
 *
 * An adapter, like the MCP server: routes parse HTTP, hand the application a
 * typed input and a call context, and render the result. Reads, analysis,
 * proposal, apply, and verify routes run the same tool handlers as MCP, so
 * both surfaces enforce the same contracts. Two things are REST-only, because
 * a human does them: recording a decision on a proposal, and submitting a
 * change as an asynchronous job whose progress the UI follows.
 *
 * Authorization is server-side: the production allow-list from the server
 * context, checked before any handler runs. The acting identity comes from
 * the `X-Actor-Id` header (a deployment would put an auth layer in front);
 * `X-Correlation-Id` is honoured when present and always echoed back.
 */

export type ApiDependencies = {
  readonly repositories: RepositorySet;
  readonly tracker: JobTracker;
  readonly queue: QueuePort;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly context: ServerContext;
  readonly logger?: ApiLogger;
  /** Tool handlers to run; defaults to the full MCP set over the same repositories. */
  readonly handlers?: ToolHandlers;
};

export const API_PREFIX = "/api";

const CORRELATION_HEADER = "x-correlation-id";
const ACTOR_HEADER = "x-actor-id";

type Call = CallContext & { readonly actorId: string };

const callOf = (request: Request, context: ServerContext, ids: IdFactory): Call => {
  const header = request.header(CORRELATION_HEADER)?.trim();
  const correlationId = header !== undefined && header.length > 0 ? header : ids.next("corr");
  const actorHeader = request.header(ACTOR_HEADER)?.trim();
  const actorId =
    actorHeader !== undefined && actorHeader.length > 0 ? actorHeader : context.actor.id;
  return { correlationId, actor: { type: "USER", id: actorId }, actorId };
};

const respond = <T>(
  response: Response,
  result: UseCaseResult<T>,
  correlationId: string,
  status = 200,
): void => {
  if (result.ok) {
    response.status(status).json(result.value);
    return;
  }
  sendError(response, result.error, correlationId);
};

const submitChangeBodySchema = z.strictObject({
  text: z.string().min(1).max(2000),
  change: typedChangeSchema.optional(),
  /** Resume a job that is waiting at `resolving` with the change the user chose. */
  jobId: entityIdSchema.optional(),
});

const changeRequestBodySchema = z.strictObject({
  rawText: z.string().min(1).max(2000),
  change: typedChangeSchema,
});

const decisionBodySchema = z.strictObject({
  decision: approvalDecisionSchema,
});

const applyBodySchema = z.strictObject({
  approvalId: entityIdSchema,
  expectedProductionVersion: z.int().positive(),
  idempotencyKey: z.string().min(8).max(200),
  /** When given, the apply runs as a job that continues this run's timeline. */
  jobId: entityIdSchema.optional(),
});

const listProposalsQuerySchema = z.strictObject({ status: proposalStatusSchema });

const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const issueMessage = (error: z.ZodError): { message: string; path: string } => {
  const issue = error.issues[0];
  return {
    message: `The request is malformed: ${issue?.message ?? "unknown issue"}.`,
    path: issue?.path.join(".") ?? "<root>",
  };
};

export const createApiApp = (dependencies: ApiDependencies): Express => {
  const { repositories, tracker, queue, clock, ids, context } = dependencies;
  const logger = dependencies.logger ?? silentApiLogger;
  const handlers = dependencies.handlers ?? createAllToolHandlers({ repositories, clock, ids });
  const decide: DecideProposal = createDecideProposal({ repositories, clock, ids });
  const apply: ApplyApprovedProposal = createApplyApprovedProposal({ repositories, clock, ids });
  const submit = createSubmitChangeRequest({ repositories, clock, ids });
  // The tracker is the job-run store the queries read; `save` never runs through this path.
  const jobRuns = {
    findById: (jobId: EntityId) => tracker.get(jobId),
    listByProduction: (productionId: EntityId) => tracker.listByProduction(productionId),
    save: () => Promise.resolve(),
  };
  const getJobRun: GetJobRun = createGetJobRun({ jobRuns });
  const getSnapshot: GetRecoverySnapshot = createGetRecoverySnapshot({
    repositories,
    jobRuns,
    clock,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // Every request: a call context, echoed correlation ID, one log line.
  app.use((request, response, next) => {
    const call = callOf(request, context, ids);
    response.locals["call"] = call;
    response.setHeader("X-Correlation-Id", call.correlationId);
    const startedAt = Date.now();
    response.on("finish", () => {
      logger.log("info", "http_request", {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        correlationId: call.correlationId,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  const router = express.Router();

  router.get("/health", (_request, response) => {
    response.json({ status: "ok", time: clock.now() });
  });

  // Production scope: authorise once, then hand every route the ID and the call.
  router.use("/productions/:productionId", (request, response, next) => {
    const call = response.locals["call"] as Call;
    const productionId = request.params["productionId"];
    const denied = authorize(context, productionId);
    if (denied !== null) {
      sendError(response, denied, call.correlationId);
      return;
    }
    response.locals["productionId"] = productionId;
    next();
  });

  const scoped = express.Router({ mergeParams: true });
  router.use("/productions/:productionId", scoped);

  const tool =
    <TName extends Parameters<typeof invokeTool>[1]>(
      name: TName,
      input: (request: Request, productionId: EntityId) => unknown,
      status = 200,
    ) =>
    async (request: Request, response: Response): Promise<void> => {
      const call = response.locals["call"] as Call;
      const productionId = response.locals["productionId"] as EntityId;
      const result = await invokeTool(handlers, name, input(request, productionId), call, logger);
      respond(response, result, call.correlationId, status);
    };

  const query = (request: Request, name: string): string | undefined => {
    const value = request.query[name];
    return typeof value === "string" ? value : undefined;
  };
  const optional = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

  // Reads (the nine read tools).
  scoped.get(
    "/",
    tool("get_production", (_request, productionId) => ({ productionId })),
  );
  scoped.get(
    "/scenes/:sceneId",
    tool("get_scene", (request, productionId) => ({
      productionId,
      sceneId: request.params["sceneId"],
    })),
  );
  scoped.get(
    "/cast",
    tool("find_cast", (request, productionId) => ({
      productionId,
      query: query(request, "query"),
    })),
  );
  scoped.get(
    "/cast/availability",
    tool("get_cast_availability", (request, productionId) => ({
      productionId,
      ...optional({
        from: query(request, "from"),
        to: query(request, "to"),
        castId: query(request, "castId"),
      }),
    })),
  );
  scoped.get(
    "/locations",
    tool("find_location", (request, productionId) => ({
      productionId,
      query: query(request, "query"),
    })),
  );
  scoped.get(
    "/locations/availability",
    tool("get_location_availability", (request, productionId) => ({
      productionId,
      ...optional({
        from: query(request, "from"),
        to: query(request, "to"),
        locationId: query(request, "locationId"),
      }),
    })),
  );
  scoped.get(
    "/schedule",
    tool("get_schedule", (request, productionId) => ({
      productionId,
      ...optional({ date: query(request, "date"), sceneId: query(request, "sceneId") }),
    })),
  );
  scoped.get(
    "/call-sheets/:shootDayId",
    tool("get_call_sheet", (request, productionId) => ({
      productionId,
      shootDayId: request.params["shootDayId"],
    })),
  );
  scoped.get(
    "/tasks",
    tool("get_tasks", (request, productionId) => ({
      productionId,
      ...optional({
        relatedEntityType: query(request, "relatedEntityType"),
        relatedEntityId: query(request, "relatedEntityId"),
      }),
    })),
  );

  // Analysis and proposal tools: the body is the tool input minus the production.
  const withProduction = (request: Request, productionId: EntityId): unknown =>
    typeof request.body === "object" && request.body !== null
      ? { ...(request.body as Record<string, unknown>), productionId }
      : { productionId };
  scoped.post("/analysis", tool("analyze_change_impact", withProduction));
  scoped.post("/candidates", tool("generate_schedule_candidates", withProduction));
  scoped.post("/simulations", tool("simulate_proposal", withProduction));
  scoped.post("/proposals", tool("create_proposal", withProduction, 201));
  scoped.get(
    "/proposals/:proposalId",
    tool("get_proposal", (request, productionId) => ({
      productionId,
      proposalId: request.params["proposalId"],
    })),
  );
  scoped.post(
    "/proposals/:proposalId/validation",
    tool("validate_proposal", (request, productionId) => ({
      productionId,
      proposalId: request.params["proposalId"],
    })),
  );
  scoped.post(
    "/proposals/:proposalId/verification",
    tool("verify_applied_proposal", (request, productionId) => ({
      productionId,
      proposalId: request.params["proposalId"],
    })),
  );

  scoped.get("/proposals", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = listProposalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const proposals = await repositories.proposals.listByStatus(productionId, parsed.data.status);
    response.json({ proposals });
  });

  // A human's decision: REST-only by design (MCP.md §6 has no approve tool).
  scoped.post("/proposals/:proposalId/decision", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = decisionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const result = await decide({
      productionId,
      proposalId: request.params["proposalId"],
      decision: parsed.data.decision,
      decidedBy: call.actorId,
      correlationId: call.correlationId,
    });
    respond(response, result, call.correlationId);
  });

  // Apply: synchronous, or as a job continuing a run's timeline when `jobId` is given.
  scoped.post("/proposals/:proposalId/apply", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = applyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const proposalId = request.params["proposalId"];
    const { jobId, ...body } = parsed.data;
    if (jobId === undefined) {
      const result = await apply({
        productionId,
        proposalId,
        ...body,
        appliedBy: call.actorId,
        correlationId: call.correlationId,
      });
      respond(response, result, call.correlationId);
      return;
    }
    const run = await tracker.get(jobId);
    if (run === null || run.productionId !== productionId) {
      sendError(
        response,
        {
          code: "ENTITY_NOT_FOUND",
          message: `Job ${jobId} does not exist in production ${productionId}.`,
          nextStep: "List the production's jobs and use one of them.",
        },
        call.correlationId,
      );
      return;
    }
    await queue.enqueue({
      type: "APPLY_PROPOSAL",
      productionId,
      correlationId: run.correlationId,
      idempotencyKey: `apply:${body.idempotencyKey}`,
      payload: { jobId, proposalId, ...body, appliedBy: call.actorId },
    });
    response.status(202).json({ job: run });
  });

  // A change as a job: the UI follows the timeline; the result is a proposal awaiting approval.
  scoped.post("/changes", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = submitChangeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const { text, change, jobId } = parsed.data;
    let run = jobId === undefined ? null : await tracker.get(jobId);
    if (jobId !== undefined && (run === null || run.productionId !== productionId)) {
      sendError(
        response,
        {
          code: "ENTITY_NOT_FOUND",
          message: `Job ${jobId} does not exist in production ${productionId}.`,
          nextStep: "Omit jobId to start a new job.",
        },
        call.correlationId,
      );
      return;
    }
    run ??= await tracker.start({
      productionId,
      correlationId: call.correlationId,
      type: "ANALYZE_CHANGE",
    });
    await queue.enqueue({
      type: "ANALYZE_CHANGE",
      productionId,
      correlationId: run.correlationId,
      idempotencyKey: `analyze:${run.id}:${run.history.length}`,
      payload: {
        jobId: run.id,
        text,
        ...(change === undefined ? {} : { change }),
        requestedBy: call.actorId,
      },
    });
    response.status(202).json({ job: run });
  });

  // Intake without a job: the synchronous path a script or an E2E test drives step by step.
  scoped.post("/change-requests", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = changeRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const result = await submit({
      productionId,
      rawText: parsed.data.rawText,
      change: parsed.data.change,
      createdBy: call.actorId,
      correlationId: call.correlationId,
    });
    respond(response, result, call.correlationId, 201);
  });

  scoped.get("/change-requests/:changeRequestId", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const changeRequestId = request.params["changeRequestId"];
    const found = await repositories.changeRequests.findById(productionId, changeRequestId);
    if (found === null) {
      sendError(
        response,
        {
          code: "ENTITY_NOT_FOUND",
          message: `Change request ${changeRequestId} does not exist in production ${productionId}.`,
        },
        call.correlationId,
      );
      return;
    }
    response.json(found);
  });

  scoped.get("/jobs", async (_request, response) => {
    const productionId = response.locals["productionId"] as EntityId;
    response.json({ jobs: await tracker.listByProduction(productionId) });
  });

  scoped.get("/jobs/:jobId", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const result = await getJobRun({
      productionId,
      jobId: request.params["jobId"],
      correlationId: call.correlationId,
    });
    respond(response, result, call.correlationId);
  });

  scoped.get("/recovery", async (_request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    respond(
      response,
      await getSnapshot({ productionId, correlationId: call.correlationId }),
      call.correlationId,
    );
  });

  scoped.get("/audit", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const events = await repositories.auditEvents.list(
      productionId,
      parsed.data.limit === undefined ? {} : { limit: parsed.data.limit },
    );
    response.json({ events });
  });

  app.use(API_PREFIX, router);

  // Unknown routes and malformed bodies are errors in the same shape as everything else.
  app.use((request: Request, response: Response) => {
    const call = response.locals["call"] as Call;
    sendError(
      response,
      {
        code: "ENTITY_NOT_FOUND",
        message: `No route for ${request.method} ${request.path}.`,
        nextStep: `Routes live under ${API_PREFIX}/productions/:productionId.`,
      },
      call.correlationId,
    );
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const call = (response.locals["call"] as Call | undefined) ?? {
      correlationId: ids.next("corr"),
    };
    const isBodyError =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.parse.failed";
    const toolError: ToolError = isBodyError
      ? invalidInput("The request body is not valid JSON.")
      : { code: "INTERNAL_ERROR", message: "The request failed unexpectedly." };
    logger.log(isBodyError ? "warn" : "error", "http_error", {
      correlationId: call.correlationId,
      status: HTTP_STATUS_BY_CODE[toolError.code],
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(response, toolError, call.correlationId);
  });

  return app;
};
