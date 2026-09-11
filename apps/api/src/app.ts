import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type {
  AnalyzeChangeImpact,
  ApplyApprovedProposal,
  Clock,
  DecideProposal,
  GetJobRun,
  GetRecoverySnapshot,
  IdFactory,
  IdentityPort,
  IdentityRefusal,
  JobTracker,
  StoreProbe,
  QueuePort,
  RepositorySet,
  UseCaseResult,
} from "@pca/application";
import {
  createAnalyzeChangeImpact,
  createApplyApprovedProposal,
  createDecideProposal,
  createGetJobRun,
  createGetRecoverySnapshot,
  createSubmitChangeRequest,
  describeJobMismatch,
  findCredential,
} from "@pca/application";
import type { EntityId, Principal, PrincipalRole, ToolError } from "@pca/contracts";
import {
  approvalDecisionSchema,
  correlationIdSchema,
  entityIdSchema,
  principalHasRole,
  principalMayAccess,
  proposalStatusSchema,
  typedChangeSchema,
} from "@pca/contracts";
import type { ServerContext } from "@pca/mcp-server/context";
import { authorize } from "@pca/mcp-server/context";
import type { CallContext, ToolHandlers } from "@pca/mcp-server/handlers";
import { createAllToolHandlers } from "@pca/mcp-server/handlers";

import { HTTP_STATUS_BY_CODE, invalidInput, sendError } from "./errors";
import { invokeTool } from "./invoke";
import { clientAddressOf, createRateLimiter, rateLimit } from "./rate-limit";
import { securityHeaders } from "./security-headers";
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
 * Identity is verified, never declared (TASK-914, SEC-001 / AUD-001): every
 * route but `/health` and the demo-session route requires a bearer token the
 * identity port accepts, and the acting identity — what approvals and audit
 * events record — is the verified principal's subject. No header names the
 * actor. Authorization is server-side and twofold: the production must be on
 * the server's allow-list *and* in the principal's grant, checked before any
 * handler runs; reads need the `viewer` role and writes `requester`, while
 * the decision route's `approver` requirement lives in the use case itself.
 * `X-Correlation-Id` is honoured when present and always echoed back.
 *
 * Three things are REST-only, because a human or the UI does them and the
 * MCP tool contracts have no room for them: recording a decision on a
 * proposal, submitting a change as an asynchronous job whose progress the
 * UI follows, and the DESIGN.md §3 impact panel (`.../analysis/explanation`,
 * TASK-503) — the agent-facing `analyze_change_impact` tool returns only
 * `impacts`/`conflicts`, the machine-readable form it reasons over.
 */

export type ApiDependencies = {
  readonly repositories: RepositorySet;
  readonly tracker: JobTracker;
  readonly queue: QueuePort;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly context: ServerContext;
  /** Verifies bearer tokens into principals; the only source of identity. */
  readonly identity: IdentityPort;
  /**
   * Demo mode only: mints the demo coordinator's token for anyone who asks
   * `GET /api/auth/demo-session`. Absent in a deployment, where the route
   * answers 404 and tokens come from the operator.
   */
  readonly demoSession?: () => string;
  /** Refuse a decision by the principal who submitted the change. Default: on. */
  readonly makerChecker?: boolean;
  /**
   * Request quotas (TASK-917): every request per client address, and writes
   * under a production per verified principal. Defaults: 600 and 60 per minute.
   */
  readonly limits?: {
    readonly requestsPerMinute?: number;
    readonly writesPerMinute?: number;
  };
  /** The service is reached over TLS; answers then carry HSTS (TASK-928). */
  readonly tlsTerminated?: boolean;
  /** Store reachability for `/ready` (TASK-931); a memory store that is always ready by default. */
  readonly probeStore?: StoreProbe;
  readonly logger?: ApiLogger;
  /** Tool handlers to run; defaults to the full MCP set over the same repositories. */
  readonly handlers?: ToolHandlers;
};

export const API_PREFIX = "/api";

export const DEFAULT_REQUESTS_PER_MINUTE = 600;
export const DEFAULT_WRITES_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

const CORRELATION_HEADER = "x-correlation-id";

type Call = CallContext & { readonly actorId: string; readonly principal: Principal };

/**
 * TASK-906 (code review #7 / SEC-006 / AUD-010): the correlation header is
 * validated against the contract the persisted records enforce; an unusable
 * one is replaced with a fresh ID (tracing degrades, the request proceeds).
 * The actor header TASK-906 also validated is gone (TASK-914): identity is
 * derived from the verified principal and nothing a caller types.
 */
const correlationIdOf = (request: Request, ids: IdFactory): string => {
  const header = request.header(CORRELATION_HEADER)?.trim();
  const parsed = correlationIdSchema.safeParse(header);
  return parsed.success ? parsed.data : ids.next("corr");
};

/** `Authorization: Bearer <token>`; anything else is treated as no credential. */
export const bearerTokenOf = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
};

const UNAUTHENTICATED_NEXT_STEP =
  "Send a valid access token as `Authorization: Bearer <token>`; in demo mode, GET /api/auth/demo-session issues one.";

export const unauthenticated = (reason: IdentityRefusal | "MISSING"): ToolError => ({
  code: "UNAUTHENTICATED",
  message: {
    MISSING: "This request carries no access token.",
    MALFORMED: "The access token is not one this server issued.",
    BAD_SIGNATURE: "The access token's signature does not verify.",
    EXPIRED: "The access token has expired.",
    NOT_YET_VALID: "The access token is not valid yet.",
  }[reason],
  nextStep: UNAUTHENTICATED_NEXT_STEP,
});

/** TASK-922: the kind is named, the value never echoed. */
const credentialRefused = (kind: string): ToolError => ({
  code: "INVALID_INPUT",
  message: `The change text appears to contain a ${kind}; credentials are never stored with a production.`,
  actual: kind,
  nextStep: "Remove the credential from the sentence and submit it again.",
});

/** The least role a method needs; the decision route's `approver` is enforced in the use case. */
const roleForMethod = (method: string): PrincipalRole =>
  method === "GET" ? "viewer" : "requester";

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

const impactExplanationBodySchema = z.strictObject({ change: typedChangeSchema });

const decisionBodySchema = z.strictObject({
  decision: approvalDecisionSchema,
  /** A rejection completes the job it came from (SPEC.md §7); an approval leaves it for `.../apply`. */
  jobId: entityIdSchema.optional(),
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
  const handlers =
    dependencies.handlers ?? createAllToolHandlers({ repositories, clock, ids, logger });
  const decide: DecideProposal = createDecideProposal({
    repositories,
    clock,
    ids,
    makerChecker: dependencies.makerChecker ?? true,
  });
  const apply: ApplyApprovedProposal = createApplyApprovedProposal({ repositories, clock, ids });
  const submit = createSubmitChangeRequest({ repositories, clock, ids });
  const analyzeImpact: AnalyzeChangeImpact = createAnalyzeChangeImpact({ repositories, logger });
  // The tracker is the job-run store the queries read. They take the read
  // side only (`JobRunReader`), so no write capability is faked here.
  const jobRuns = {
    findById: (jobId: EntityId) => tracker.get(jobId),
    listByProduction: (productionId: EntityId) => tracker.listByProduction(productionId),
  };
  const getJobRun: GetJobRun = createGetJobRun({ jobRuns });
  const getSnapshot: GetRecoverySnapshot = createGetRecoverySnapshot({
    repositories,
    jobRuns,
    clock,
  });

  const app = express();
  app.disable("x-powered-by");
  // First, on every answer including errors and 404s (TASK-928).
  app.use(securityHeaders({ tlsTerminated: dependencies.tlsTerminated ?? false }));
  app.use(express.json({ limit: "256kb" }));

  // Every request: an echoed correlation ID and one log line.
  app.use((request, response, next) => {
    const correlationId = correlationIdOf(request, ids);
    response.locals["correlationId"] = correlationId;
    response.setHeader("X-Correlation-Id", correlationId);
    const startedAt = Date.now();
    response.on("finish", () => {
      logger.log("info", "http_request", {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        correlationId,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  const router = express.Router();

  // Quotas (TASK-917): every request by client address, before anything else
  // spends work on it; writes under a production by principal, once known.
  const requestRule = {
    limit: dependencies.limits?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE,
    windowMs: MINUTE_MS,
  };
  const writeRule = {
    limit: dependencies.limits?.writesPerMinute ?? DEFAULT_WRITES_PER_MINUTE,
    windowMs: MINUTE_MS,
  };
  const requestLimiter = createRateLimiter(requestRule);
  const writeLimiter = createRateLimiter(writeRule);
  router.use(rateLimit(requestLimiter, requestRule, clientAddressOf, "requests from this client"));
  const writeLimit = rateLimit(
    writeLimiter,
    writeRule,
    (_request, response) => (response.locals["call"] as Call).principal.subject,
    "writes by this principal",
  );

  // Liveness: the process answers.
  router.get("/health", (_request, response) => {
    response.json({ status: "ok", time: clock.now() });
  });

  // Readiness (TASK-931, AUD-021): can it do its job, and how loaded is it?
  // Counters only — no IDs, no URIs, no paths — so it can sit in front of
  // the token check like /health; 503 when the store cannot be reached.
  const probeStore: StoreProbe =
    dependencies.probeStore ?? (() => Promise.resolve({ kind: "memory", ok: true }));
  router.get("/ready", async (_request, response) => {
    const [store, queueStats, unfinished] = await Promise.all([
      probeStore().catch((): Awaited<ReturnType<StoreProbe>> => ({
        kind: "memory",
        ok: false,
        detail: "The store probe threw.",
      })),
      queue.stats(),
      tracker.listUnfinished(),
    ]);
    const waitingOnHuman = unfinished.filter(
      (run) => run.stage === "resolving" || run.stage === "awaiting_approval",
    ).length;
    response.status(store.ok ? 200 : 503).json({
      status: store.ok ? "ready" : "not_ready",
      time: clock.now(),
      store,
      queue: queueStats,
      jobs: {
        unfinished: unfinished.length,
        waitingOnHuman,
        inFlight: unfinished.length - waitingOnHuman,
      },
      rateLimit: {
        rejectedRequests: requestLimiter.rejected(),
        rejectedWrites: writeLimiter.rejected(),
      },
    });
  });

  // Demo mode's front door (TASK-914): the one route that hands out a token,
  // and it exists only when the composition root said this is a demo.
  router.get("/auth/demo-session", async (_request, response) => {
    const correlationId = response.locals["correlationId"] as string;
    const demoSession = dependencies.demoSession;
    if (demoSession === undefined) {
      sendError(
        response,
        {
          code: "ENTITY_NOT_FOUND",
          message: "This server does not issue demo sessions.",
          nextStep: "Obtain an access token from the operator (`pnpm run token`).",
        },
        correlationId,
      );
      return;
    }
    const token = demoSession();
    const verified = await dependencies.identity.verify(token);
    if (!verified.ok) {
      sendError(
        response,
        { code: "INTERNAL_ERROR", message: "The demo session could not be issued." },
        correlationId,
      );
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ token, principal: verified.principal });
  });

  // Identity (TASK-914): everything past this point runs as a verified principal.
  router.use(async (request, response, next) => {
    const correlationId = response.locals["correlationId"] as string;
    const token = bearerTokenOf(request.header("authorization"));
    if (token === null) {
      sendError(response, unauthenticated("MISSING"), correlationId);
      return;
    }
    const verified = await dependencies.identity.verify(token);
    if (!verified.ok) {
      logger.log("warn", "http_unauthenticated", { correlationId, reason: verified.reason });
      sendError(response, unauthenticated(verified.reason), correlationId);
      return;
    }
    const { principal } = verified;
    const call: Call = {
      correlationId,
      actor: { type: principal.type, id: principal.subject },
      actorId: principal.subject,
      principal,
    };
    response.locals["call"] = call;
    next();
  });

  // Production scope: the server's allow-list and the principal's grant must
  // both name it, and the method's role must be held. Then every route gets
  // the ID and the call.
  router.use("/productions/:productionId", (request, response, next) => {
    const call = response.locals["call"] as Call;
    const productionId = request.params["productionId"];
    const denied = authorize(context, productionId);
    if (denied !== null) {
      sendError(response, denied, call.correlationId);
      return;
    }
    if (!principalMayAccess(call.principal, productionId)) {
      sendError(
        response,
        {
          code: "TOOL_UNAUTHORIZED",
          message: `${call.principal.subject}'s access token does not grant production ${productionId}.`,
          actual: productionId,
          nextStep:
            "Use a production the token was issued for, or ask the operator for a token that names this one.",
        },
        call.correlationId,
      );
      return;
    }
    const role = roleForMethod(request.method);
    if (!principalHasRole(call.principal, role)) {
      sendError(
        response,
        {
          code: "TOOL_UNAUTHORIZED",
          message: `${call.principal.subject} holds ${call.principal.roles.join(", ")}; ${request.method} here needs the ${role} role.`,
          expected: role,
          actual: call.principal.roles.join(","),
          nextStep: "Ask the operator for a token with the required role.",
        },
        call.correlationId,
      );
      return;
    }
    response.locals["productionId"] = productionId;
    next();
  });

  const scoped = express.Router({ mergeParams: true });
  router.use("/productions/:productionId", scoped);
  scoped.use((request, response, next) => {
    if (request.method === "GET") {
      next();
      return;
    }
    writeLimit(request, response, next);
  });

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
      ...optional({
        date: query(request, "date"),
        sceneId: query(request, "sceneId"),
        includeScenes: query(request, "includeScenes") === "true" ? true : undefined,
      }),
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

  // DESIGN.md §3 impact panel (TASK-503): the same analysis, rendered for a
  // human — BLOCKING, AFFECTED grouped by kind, and WHY, built by
  // `describeImpact` from the snapshot the analysis was computed against.
  scoped.post("/analysis/explanation", async (request, response) => {
    const call = response.locals["call"] as Call;
    const productionId = response.locals["productionId"] as EntityId;
    const parsed = impactExplanationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const { message, path } = issueMessage(parsed.error);
      sendError(response, invalidInput(message, path), call.correlationId);
      return;
    }
    const result = await analyzeImpact({
      productionId,
      change: parsed.data.change,
      correlationId: call.correlationId,
    });
    if (!result.ok) {
      sendError(response, result.error, call.correlationId);
      return;
    }
    response.json(result.value.explanation);
  });

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
    const proposalId = request.params["proposalId"];
    // TASK-919: the job named must be the analysis that produced this very
    // proposal, still awaiting the decision (or already closed, for a
    // replay) — checked before the decision so a mismatch changes nothing.
    if (parsed.data.jobId !== undefined) {
      const mismatch = describeJobMismatch(await tracker.get(parsed.data.jobId), {
        productionId,
        type: "ANALYZE_CHANGE",
        proposalId,
        stages: ["awaiting_approval", "completed", "failed"],
      });
      if (mismatch !== null) {
        sendError(response, mismatch, call.correlationId);
        return;
      }
    }
    const result = await decide({
      productionId,
      proposalId,
      decision: parsed.data.decision,
      decidedBy: {
        subject: call.principal.subject,
        issuer: call.principal.issuer,
        roles: call.principal.roles,
      },
      correlationId: call.correlationId,
    });
    if (result.ok && parsed.data.decision === "REJECT" && parsed.data.jobId !== undefined) {
      // Best-effort bookkeeping: the decision itself already succeeded either way.
      // Idempotent by construction — a replayed reject finds the job already closed
      // and the expectation refuses the move, so this never double-completes it.
      const run = await tracker.get(parsed.data.jobId);
      if (run !== null && run.stage === "awaiting_approval") {
        await tracker
          .advance(parsed.data.jobId, "completed", {
            message: "Rejected; nothing will change.",
            expect: { stage: "awaiting_approval", proposalId },
          })
          .catch((error: unknown) => {
            logger.log("warn", "job_reject_advance_failed", {
              jobId: parsed.data.jobId,
              correlationId: call.correlationId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }
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
    // TASK-919: only the analysis that produced this proposal, and only
    // from awaiting_approval; a job already applying, verifying, or done
    // for this same proposal is a replay and is answered with its run.
    const mismatch = describeJobMismatch(run, {
      productionId,
      type: "ANALYZE_CHANGE",
      proposalId,
      stages: ["awaiting_approval", "applying", "verifying", "completed"],
    });
    if (mismatch !== null || run === null) {
      sendError(response, mismatch ?? invalidInput("Job is missing."), call.correlationId);
      return;
    }
    if (run.stage !== "awaiting_approval") {
      response.status(202).json({ job: run });
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
    // TASK-922: a credential never reaches the queue, the job, or the store.
    const credential = findCredential(text);
    if (credential !== null) {
      sendError(response, credentialRefused(credential), call.correlationId);
      return;
    }
    let run = jobId === undefined ? null : await tracker.get(jobId);
    if (jobId !== undefined) {
      // TASK-919: resuming continues one's own analysis, waiting at resolving.
      const mismatch = describeJobMismatch(run, {
        productionId,
        type: "ANALYZE_CHANGE",
        stages: ["resolving"],
        requestedBy: call.actorId,
      });
      if (mismatch !== null) {
        sendError(response, mismatch, call.correlationId);
        return;
      }
    }
    run ??= await tracker.start({
      productionId,
      correlationId: call.correlationId,
      type: "ANALYZE_CHANGE",
      requestedBy: call.actorId,
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
    const credential = findCredential(parsed.data.rawText);
    if (credential !== null) {
      sendError(response, credentialRefused(credential), call.correlationId);
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
    const correlationId = response.locals["correlationId"] as string;
    sendError(
      response,
      {
        code: "ENTITY_NOT_FOUND",
        message: `No route for ${request.method} ${request.path}.`,
        nextStep: `Routes live under ${API_PREFIX}/productions/:productionId.`,
      },
      correlationId,
    );
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const call = {
      correlationId: (response.locals["correlationId"] as string | undefined) ?? ids.next("corr"),
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
