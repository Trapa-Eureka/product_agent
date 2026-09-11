import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindQueueToJobTracker,
  createAnalyzeChangeJobHandler,
  createApplyApprovedProposal,
  createApplyProposalJobHandler,
  createJobTracker,
  createNotificationHub,
  createRunChangeAgent,
  createVerifyAppliedProposal,
  forwardJobEvents,
  withProposalNotifications,
  type JobTracker,
} from "@pca/application";
import type { Proposal, ProposedOperation, ToolError } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import {
  createMemoryJobRunRepository,
  createMemoryQueue,
  type MemoryQueue,
} from "@pca/memory-queue";
import type { Principal } from "@pca/contracts";
import { createLocalIdentity, issueToken } from "@pca/local-auth";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";
import { fixedClock, onDay, principal, sequentialIds } from "@pca/test-support";

import { rawDataToText } from "@pca/ws-gateway";

import { createApiServer, type ApiServer } from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, tuesday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T12:00:00.000Z";
const SECRET = "api-contract-secret-".padEnd(32, "x");
const clock = fixedClock(NOW);

/** A signed token for `who` (TASK-914): what every request below carries unless it says otherwise. */
const tokenFor = (who: Principal): string => issueToken({ secret: SECRET, principal: who, clock });
const JINHO = principal("jinho@example.test", { productions: [DEMO] });
const JINHO_TOKEN = tokenFor(JINHO);

const golden1: ProposedOperation[] = [
  { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.tuesday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
];

type Reply = { status: number; body: unknown; headers: Headers };

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("REST API", () => {
  let store: MemoryStore;
  let queue: MemoryQueue;
  let tracker: JobTracker;
  let server: ApiServer;
  let base: string;
  let websocketUrl: string;

  const api = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${JINHO_TOKEN}`,
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? null : (JSON.parse(text) as unknown),
      headers: response.headers,
    };
  };

  const errorOf = (reply: Reply): ToolError => (reply.body as { error: ToolError }).error;

  /** GOLDEN-1's change request and proposal through REST, as Jinho; returns the proposal ID. */
  const proposeViaRest = async (): Promise<string> => {
    await api("POST", `/productions/${DEMO}/change-requests`, {
      rawText: "Sarah cannot shoot Friday.",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
    });
    const created = await api("POST", `/productions/${DEMO}/proposals`, {
      changeRequestId: "CR-1",
      baseProductionVersion: 1,
      operations: golden1,
      summary: "Move to Tuesday",
    });
    expect(created.status).toBe(201);
    return (created.body as { proposal: Proposal }).proposal.id;
  };

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    const ids = sequentialIds();
    const hub = createNotificationHub();
    const repositories = withProposalNotifications(store, hub, clock);
    queue = createMemoryQueue({ clock, ids, policy: { maxAttempts: 2, retryDelayMs: () => 0 } });
    tracker = createJobTracker({ repository: createMemoryJobRunRepository(), clock, ids });
    forwardJobEvents(tracker, hub);
    bindQueueToJobTracker(queue, tracker);
    const model = createRuleModelAdapter();
    queue.register(
      "ANALYZE_CHANGE",
      createAnalyzeChangeJobHandler({
        tracker,
        runChangeAgent: createRunChangeAgent({ repositories, model, clock, ids }),
      }),
    );
    queue.register(
      "APPLY_PROPOSAL",
      createApplyProposalJobHandler({
        tracker,
        apply: createApplyApprovedProposal({ repositories, clock, ids }),
        verify: createVerifyAppliedProposal({ repositories, clock, ids }),
      }),
    );
    server = createApiServer({
      repositories,
      tracker,
      queue,
      hub,
      clock,
      ids,
      context: { actor: { type: "USER", id: "api-user" }, allowedProductionIds: [DEMO] },
      identity: createLocalIdentity({ secret: SECRET, clock }),
      // The flows below have one coordinator submit and approve; the
      // maker-checker case has its own test.
      makerChecker: false,
      allowedOrigins: ["http://localhost:4200"],
    });
    const bound = await server.listen(0);
    base = bound.url;
    websocketUrl = bound.websocketUrl;
  });

  afterEach(async () => {
    await server.close();
  });

  describe("context boundaries", () => {
    it("answers health and echoes or generates a correlation ID", async () => {
      const given = await api("GET", "/health", undefined, { "x-correlation-id": "corr-given" });
      expect(given.status).toBe(200);
      expect(given.body).toEqual({ status: "ok", time: NOW });
      expect(given.headers.get("x-correlation-id")).toBe("corr-given");
      const generated = await api("GET", "/health");
      expect(generated.headers.get("x-correlation-id")).toMatch(/^corr-/);
    });

    it("TASK-906: replaces an unusable correlation ID", async () => {
      // 129 characters: one over the contract every persisted record enforces.
      // Before this, the header was accepted, written into the change request,
      // and made every later read of the file store fail with STORE_CORRUPT.
      const tooLong = await api("GET", "/health", undefined, {
        "x-correlation-id": "c".repeat(129),
      });
      expect(tooLong.status).toBe(200);
      expect(tooLong.headers.get("x-correlation-id")).toMatch(/^corr-/);
    });

    it("refuses a production outside the allow-list before touching anything", async () => {
      const reply = await api("GET", "/productions/PROD-OTHER");
      expect(reply.status).toBe(403);
      expect(errorOf(reply)).toMatchObject({ code: "TOOL_UNAUTHORIZED", actual: "PROD-OTHER" });
    });

    it("returns a stable not-found error for unknown routes and entities", async () => {
      const route = await api("GET", "/nowhere");
      expect(route.status).toBe(404);
      expect(errorOf(route).code).toBe("ENTITY_NOT_FOUND");
      const scene = await api("GET", `/productions/${DEMO}/scenes/S99`);
      expect(scene.status).toBe(404);
      expect(errorOf(scene)).toMatchObject({
        code: "ENTITY_NOT_FOUND",
        correlationId: expect.any(String) as string,
      });
    });

    it("rejects malformed JSON and a body that violates the contract as INVALID_INPUT", async () => {
      const broken = await api("POST", `/productions/${DEMO}/analysis`, "{not json");
      expect(broken.status).toBe(400);
      expect(errorOf(broken).code).toBe("INVALID_INPUT");
      const wrong = await api("POST", `/productions/${DEMO}/analysis`, {
        change: { type: "DELETE_EVERYTHING" },
      });
      expect(wrong.status).toBe(400);
      expect(errorOf(wrong)).toMatchObject({
        code: "INVALID_INPUT",
        actual: expect.stringContaining("change") as string,
      });
    });

    it("never lets a route name a production other than the one in the path", async () => {
      // The body says PROD-OTHER; the path says PROD-DEMO. The path wins, and the strict schema
      // would reject an extra field anyway, so cross-production smuggling is impossible.
      const reply = await api("POST", `/productions/${DEMO}/analysis`, {
        productionId: "PROD-OTHER",
        change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      });
      expect(reply.status).toBe(200);
      expect((reply.body as { productionVersion: number }).productionVersion).toBe(1);
    });
  });

  describe("reads", () => {
    it("serves the production, a scene, cast and location searches, availability, schedule, call sheet, tasks", async () => {
      expect((await api("GET", `/productions/${DEMO}`)).status).toBe(200);
      const scene = await api("GET", `/productions/${DEMO}/scenes/${scenes.s07}`);
      expect(scene.status).toBe(200);
      expect((scene.body as { scene: { sceneNumber: string } }).scene.sceneNumber).toBe("07");
      const sarah = await api("GET", `/productions/${DEMO}/cast?query=Sarah`);
      expect((sarah.body as { candidates: unknown[] }).candidates).toHaveLength(1);
      const warehouse = await api("GET", `/productions/${DEMO}/locations?query=warehouse`);
      expect((warehouse.body as { candidates: unknown[] }).candidates).toHaveLength(1);
      const availability = await api(
        "GET",
        `/productions/${DEMO}/cast/availability?castId=${cast.sarah}&from=${friday}&to=${tuesday}`,
      );
      expect(availability.status).toBe(200);
      const schedule = await api("GET", `/productions/${DEMO}/schedule?date=${friday}`);
      expect(schedule.status).toBe(200);
      expect("scenes" in (schedule.body as object)).toBe(false);
      const withScenes = await api(
        "GET",
        `/productions/${DEMO}/schedule?date=${friday}&includeScenes=true`,
      );
      expect(
        (withScenes.body as { scenes: { scene: { id: string } }[] }).scenes.map(
          (entry) => entry.scene.id,
        ),
      ).toEqual([scenes.s07, scenes.s12]);
      const sheet = await api("GET", `/productions/${DEMO}/call-sheets/${shootDays.friday}`);
      expect(sheet.status).toBe(200);
      const tasks = await api("GET", `/productions/${DEMO}/tasks`);
      expect(tasks.status).toBe(200);
      const missing = await api("GET", `/productions/${DEMO}/cast/availability?from=${friday}`);
      expect(missing.status).toBe(400);
    });
  });

  describe("GOLDEN-1 through REST alone", () => {
    it("analysis → candidates → simulation → proposal → decision → apply → verification → audit", async () => {
      const change = { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) };
      const analysis = await api(
        "POST",
        `/productions/${DEMO}/analysis`,
        { change },
        { "x-correlation-id": "corr-g1" },
      );
      expect(analysis.status).toBe(200);
      expect((analysis.body as { conflicts: unknown[] }).conflicts).toHaveLength(2);

      const explanation = await api(
        "POST",
        `/productions/${DEMO}/analysis/explanation`,
        { change },
        { "x-correlation-id": "corr-g1" },
      );
      expect(explanation.status).toBe(200);
      expect(explanation.body).toMatchObject({
        blocking: ["2 scheduled scenes conflict with Sarah's availability."],
        affected: { scenes: ["07", "12"], shootDays: ["Fri Sep 18"] },
      });

      const candidates = await api("POST", `/productions/${DEMO}/candidates`, {
        sceneIds: [scenes.s07, scenes.s12],
      });
      expect(
        (candidates.body as { candidates: { shootDayId: string }[] }).candidates.map(
          (c) => c.shootDayId,
        ),
      ).toEqual([shootDays.monday, shootDays.tuesday]);

      const intake = await api(
        "POST",
        `/productions/${DEMO}/change-requests`,
        { rawText: "Sarah cannot shoot Friday.", change },
        { "x-correlation-id": "corr-g1" },
      );
      expect(intake.status).toBe(201);
      expect((intake.body as { id: string }).id).toBe("CR-1");

      const simulation = await api("POST", `/productions/${DEMO}/simulations`, {
        baseProductionVersion: 1,
        operations: golden1,
      });
      expect((simulation.body as { valid: boolean }).valid).toBe(true);

      const created = await api(
        "POST",
        `/productions/${DEMO}/proposals`,
        {
          changeRequestId: "CR-1",
          baseProductionVersion: 1,
          operations: golden1,
          summary: "Move to Tuesday",
        },
        { "x-correlation-id": "corr-g1" },
      );
      expect(created.status).toBe(201);
      const proposal = (created.body as { proposal: Proposal }).proposal;
      expect(proposal.status).toBe("AWAITING_APPROVAL");

      const fetched = await api("GET", `/productions/${DEMO}/proposals/${proposal.id}`);
      expect(fetched.status).toBe(200);
      const awaiting = await api("GET", `/productions/${DEMO}/proposals?status=AWAITING_APPROVAL`);
      expect((awaiting.body as { proposals: Proposal[] }).proposals.map((p) => p.id)).toEqual([
        proposal.id,
      ]);

      const early = await api("POST", `/productions/${DEMO}/proposals/${proposal.id}/apply`, {
        approvalId: "A-1",
        expectedProductionVersion: 1,
        idempotencyKey: "idem-key-0001",
      });
      expect(early.status).toBe(403);
      expect(errorOf(early).code).toBe("APPROVAL_REQUIRED");

      const decided = await api(
        "POST",
        `/productions/${DEMO}/proposals/${proposal.id}/decision`,
        { decision: "APPROVE" },
        { "x-correlation-id": "corr-g1" },
      );
      expect(decided.status).toBe(200);
      const approval = (
        decided.body as {
          approval: {
            id: string;
            approvedBy: string;
            approvedByIssuer: string;
            approvedByRole: string;
          };
        }
      ).approval;
      // The identity is the token's, with who vouched for it and in what capacity (TASK-914).
      expect(approval).toMatchObject({
        approvedBy: "jinho@example.test",
        approvedByIssuer: "test",
        approvedByRole: "approver",
      });

      const applied = await api(
        "POST",
        `/productions/${DEMO}/proposals/${proposal.id}/apply`,
        { approvalId: approval.id, expectedProductionVersion: 1, idempotencyKey: "idem-key-0001" },
        { "x-correlation-id": "corr-g1" },
      );
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ applied: true, productionVersion: 2 });

      const verified = await api(
        "POST",
        `/productions/${DEMO}/proposals/${proposal.id}/verification`,
      );
      expect(verified.status).toBe(200);
      expect((verified.body as { success: boolean }).success).toBe(true);

      const audit = await api("GET", `/productions/${DEMO}/audit?limit=50`);
      const events = (audit.body as { events: { action: string; correlationId?: string }[] })
        .events;
      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining(["PROPOSAL_CREATED", "PROPOSAL_APPROVED", "PROPOSAL_APPLIED"]),
      );
      expect(
        events.filter((event) => event.correlationId === "corr-g1").length,
      ).toBeGreaterThanOrEqual(3);
      expect((await store.productions.loadState(DEMO))?.shootDays[0]?.sceneIds).toEqual([]);
    });

    it("refuses a stale version, a wrong approval, and a proposal from another production with stable codes", async () => {
      await api("POST", `/productions/${DEMO}/change-requests`, {
        rawText: "Sarah cannot shoot Friday.",
        change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      });
      const created = await api("POST", `/productions/${DEMO}/proposals`, {
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: golden1,
        summary: "Move to Tuesday",
      });
      const proposal = (created.body as { proposal: Proposal }).proposal;
      const decided = await api("POST", `/productions/${DEMO}/proposals/${proposal.id}/decision`, {
        decision: "APPROVE",
      });
      const approval = (decided.body as { approval: { id: string } }).approval;

      const stale = await api("POST", `/productions/${DEMO}/proposals/${proposal.id}/apply`, {
        approvalId: approval.id,
        expectedProductionVersion: 7,
        idempotencyKey: "idem-key-0002",
      });
      expect(stale.status).toBe(409);
      expect(errorOf(stale).code).toBe("PRODUCTION_VERSION_MISMATCH");

      const wrong = await api("POST", `/productions/${DEMO}/proposals/${proposal.id}/apply`, {
        approvalId: "A-404",
        expectedProductionVersion: 1,
        idempotencyKey: "idem-key-0003",
      });
      // An approval that does not exist is treated as no approval at all.
      expect(wrong.status).toBe(403);
      expect(errorOf(wrong).code).toBe("APPROVAL_REQUIRED");

      const staleSimulation = await api("POST", `/productions/${DEMO}/simulations`, {
        baseProductionVersion: 3,
        operations: golden1,
      });
      expect(staleSimulation.status).toBe(409);
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(1);
    });
  });

  describe("impact explanation", () => {
    it("GOLDEN-3: groups a requirement change's affected scene, and says why", async () => {
      const reply = await api("POST", `/productions/${DEMO}/analysis/explanation`, {
        change: {
          type: "SCENE_REQUIREMENT_CHANGED",
          sceneId: scenes.s18,
          requirement: { type: "PROP", name: "red car" },
        },
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ affected: { scenes: ["18"] } });
      expect((reply.body as { why: string[] }).why[0]).toContain("red car");
    });

    it("refuses an unknown production and a malformed body with stable codes", async () => {
      const change = { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) };
      const unknownProduction = await api("POST", "/productions/PROD-GHOST/analysis/explanation", {
        change,
      });
      expect(unknownProduction.status).toBe(403);
      expect(errorOf(unknownProduction).code).toBe("TOOL_UNAUTHORIZED");

      const unknownEntity = await api("POST", `/productions/${DEMO}/analysis/explanation`, {
        change: { ...change, castId: "CAST-GHOST" },
      });
      expect(unknownEntity.status).toBe(404);
      expect(errorOf(unknownEntity).code).toBe("ENTITY_NOT_FOUND");

      const malformed = await api("POST", `/productions/${DEMO}/analysis/explanation`, {
        change: { type: "DELETE_EVERYTHING" },
      });
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe("INVALID_INPUT");
    });

    it("never lets a route name a production other than the one in the path", async () => {
      const reply = await api("POST", `/productions/${DEMO}/analysis/explanation`, {
        productionId: "PROD-OTHER",
        change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      });
      expect(reply.status).toBe(400);
      expect(errorOf(reply).code).toBe("INVALID_INPUT");
    });
  });

  describe("changes as jobs", () => {
    it("submits a change, follows the job to awaiting_approval, recovers, then applies as a job", async () => {
      const submitted = await api(
        "POST",
        `/productions/${DEMO}/changes`,
        { text: "Sarah cannot shoot Friday." },
        {
          "x-correlation-id": "corr-job",
        },
      );
      expect(submitted.status).toBe(202);
      const job = (submitted.body as { job: { id: string; stage: string; correlationId: string } })
        .job;
      expect(job).toMatchObject({ stage: "received", correlationId: "corr-job" });

      await queue.drain();
      await settle();
      const followed = await api("GET", `/productions/${DEMO}/jobs/${job.id}`);
      expect(followed.status).toBe(200);
      const run = followed.body as { stage: string; proposalId?: string; history: unknown[] };
      expect(run.stage).toBe("awaiting_approval");
      expect(run.proposalId).toMatch(/^P-/);

      const listed = await api("GET", `/productions/${DEMO}/jobs`);
      expect((listed.body as { jobs: { id: string }[] }).jobs.map((entry) => entry.id)).toEqual([
        job.id,
      ]);

      const recovery = await api("GET", `/productions/${DEMO}/recovery`);
      expect(recovery.status).toBe(200);
      expect(recovery.body).toMatchObject({
        productionVersion: 1,
        jobs: [expect.objectContaining({ id: job.id })],
        openProposals: [expect.objectContaining({ id: run.proposalId })],
      });

      const decided = await api(
        "POST",
        `/productions/${DEMO}/proposals/${run.proposalId}/decision`,
        { decision: "APPROVE" },
      );
      const approval = (decided.body as { approval: { id: string } }).approval;
      const applying = await api("POST", `/productions/${DEMO}/proposals/${run.proposalId}/apply`, {
        approvalId: approval.id,
        expectedProductionVersion: 1,
        idempotencyKey: "idem-key-apply",
        jobId: job.id,
      });
      expect(applying.status).toBe(202);
      await queue.drain();
      await settle();
      const done = await api("GET", `/productions/${DEMO}/jobs/${job.id}`);
      expect((done.body as { stage: string }).stage).toBe("completed");
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(2);

      const changeRequest = await api("GET", `/productions/${DEMO}/change-requests/CR-1`);
      expect(changeRequest.status).toBe(200);
    });

    it("TASK-505: rejects a job's proposal, completing the job without changing production state", async () => {
      const submitted = await api("POST", `/productions/${DEMO}/changes`, {
        text: "Sarah cannot shoot Friday.",
      });
      const job = (submitted.body as { job: { id: string } }).job;
      await queue.drain();
      await settle();
      const followed = await api("GET", `/productions/${DEMO}/jobs/${job.id}`);
      const run = followed.body as { proposalId: string };

      const decided = await api(
        "POST",
        `/productions/${DEMO}/proposals/${run.proposalId}/decision`,
        { decision: "REJECT", jobId: job.id },
      );
      expect(decided.status).toBe(200);
      expect((decided.body as { proposal: { status: string } }).proposal.status).toBe("REJECTED");

      const done = await api("GET", `/productions/${DEMO}/jobs/${job.id}`);
      expect(done.body).toMatchObject({
        stage: "completed",
        status: "COMPLETED",
        message: "Rejected; nothing will change.",
      });
      expect((await store.productions.loadState(DEMO))?.production.version).toBe(1);

      // A replayed rejection (lenient per DOMAIN.md) does not error trying to re-complete the job.
      const repeated = await api(
        "POST",
        `/productions/${DEMO}/proposals/${run.proposalId}/decision`,
        { decision: "REJECT", jobId: job.id },
      );
      expect(repeated.status).toBe(200);
      expect((await api("GET", `/productions/${DEMO}/jobs/${job.id}`)).body).toMatchObject({
        stage: "completed",
      });
    });

    it("hands ambiguity back at resolving and resumes the same job with the chosen change", async () => {
      const state = createDemoMovie();
      await store.productions.save({
        ...state,
        castMembers: [
          ...state.castMembers,
          { id: "CAST-SARAH-2", productionId: DEMO, name: "Sarah", unavailable: [] },
        ],
      });
      const submitted = await api("POST", `/productions/${DEMO}/changes`, {
        text: "Sarah cannot shoot Friday.",
      });
      const job = (submitted.body as { job: { id: string } }).job;
      await queue.drain();
      await settle();
      const waiting = await api("GET", `/productions/${DEMO}/jobs/${job.id}`);
      expect(waiting.body).toMatchObject({
        stage: "resolving",
        message: expect.stringContaining("Which one?") as string,
      });
      const options = (waiting.body as { options: { label: string; change: unknown }[] }).options;
      expect(options).toHaveLength(2);
      expect(options.map((option) => option.change)).toEqual(
        expect.arrayContaining([
          { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
        ]),
      );

      const resumed = await api("POST", `/productions/${DEMO}/changes`, {
        text: "Sarah cannot shoot Friday.",
        change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
        jobId: job.id,
      });
      expect(resumed.status).toBe(202);
      await queue.drain();
      await settle();
      expect(
        ((await api("GET", `/productions/${DEMO}/jobs/${job.id}`)).body as { stage: string }).stage,
      ).toBe("awaiting_approval");
    });

    it("refuses a job it does not know, and an unknown job for apply", async () => {
      const resume = await api("POST", `/productions/${DEMO}/changes`, {
        text: "x",
        jobId: "JOB-404",
      });
      expect(resume.status).toBe(404);
      const apply = await api("POST", `/productions/${DEMO}/proposals/P-1/apply`, {
        approvalId: "A-1",
        expectedProductionVersion: 1,
        idempotencyKey: "idem-key-0009",
        jobId: "JOB-404",
      });
      expect(apply.status).toBe(404);
      expect(await queue.listJobs()).toEqual([]);
    });
  });

  describe("identity (TASK-914, SEC-001 / AUD-001)", () => {
    it("refuses every route but health without a token, naming the next step", async () => {
      const health = await api("GET", "/health", undefined, { authorization: "" });
      expect(health.status).toBe(200);
      const none = await api("GET", `/productions/${DEMO}`, undefined, { authorization: "" });
      expect(none.status).toBe(401);
      expect(errorOf(none)).toMatchObject({
        code: "UNAUTHENTICATED",
        message: "This request carries no access token.",
      });
      expect(errorOf(none).nextStep).toContain("Authorization: Bearer");
      const basic = await api("GET", `/productions/${DEMO}`, undefined, {
        authorization: "Basic dXNlcjpwYXNz",
      });
      expect(basic.status).toBe(401);
      // Even an unknown route answers 401 first: routes are not enumerable without a token.
      const nowhere = await api("GET", "/nowhere", undefined, { authorization: "" });
      expect(nowhere.status).toBe(401);
    });

    it("refuses a token this server did not sign, and an expired one", async () => {
      const forged = issueToken({
        secret: "not-the-server-secret".padEnd(32, "y"),
        principal: JINHO,
        clock,
      });
      const bad = await api("GET", `/productions/${DEMO}`, undefined, {
        authorization: `Bearer ${forged}`,
      });
      expect(bad.status).toBe(401);
      expect(errorOf(bad).code).toBe("UNAUTHENTICATED");
      const expired = issueToken({
        secret: SECRET,
        principal: JINHO,
        clock: fixedClock("2026-09-10T10:00:00.000Z"),
        ttlSeconds: 60,
      });
      const late = await api("GET", `/productions/${DEMO}`, undefined, {
        authorization: `Bearer ${expired}`,
      });
      expect(late.status).toBe(401);
      expect(errorOf(late).message).toBe("The access token has expired.");
    });

    it("ignores a caller-supplied X-Actor-Id: the approval records the token's subject", async () => {
      const proposalId = await proposeViaRest();
      const decided = await api(
        "POST",
        `/productions/${DEMO}/proposals/${proposalId}/decision`,
        { decision: "REJECT" },
        { "x-actor-id": "the-director@example.test" },
      );
      expect(decided.status).toBe(200);
      expect((decided.body as { approval: { approvedBy: string } }).approval.approvedBy).toBe(
        "jinho@example.test",
      );
      const audit = await api("GET", `/productions/${DEMO}/audit`);
      const events = (audit.body as { events: { action: string; actorId?: string }[] }).events;
      expect(events.find((event) => event.action === "PROPOSAL_REJECTED")?.actorId).toBe(
        "jinho@example.test",
      );
    });

    it("refuses a production the token does not grant, even though the server allows it", async () => {
      const elsewhere = tokenFor(principal("other@example.test", { productions: ["PROD-OTHER"] }));
      const reply = await api("GET", `/productions/${DEMO}`, undefined, {
        authorization: `Bearer ${elsewhere}`,
      });
      expect(reply.status).toBe(403);
      expect(errorOf(reply)).toMatchObject({ code: "TOOL_UNAUTHORIZED", actual: DEMO });
      expect(errorOf(reply).message).toContain("does not grant");
    });

    it("lets a viewer read but not write, and a requester write but not decide", async () => {
      const viewer = tokenFor(principal("viewer@example.test", { roles: ["viewer"] }));
      const read = await api("GET", `/productions/${DEMO}`, undefined, {
        authorization: `Bearer ${viewer}`,
      });
      expect(read.status).toBe(200);
      const write = await api(
        "POST",
        `/productions/${DEMO}/changes`,
        { text: "Sarah cannot shoot Friday." },
        { authorization: `Bearer ${viewer}` },
      );
      expect(write.status).toBe(403);
      expect(errorOf(write)).toMatchObject({ code: "TOOL_UNAUTHORIZED", expected: "requester" });

      const proposalId = await proposeViaRest();
      const requester = tokenFor(principal("requester@example.test", { roles: ["requester"] }));
      const decide = await api(
        "POST",
        `/productions/${DEMO}/proposals/${proposalId}/decision`,
        { decision: "APPROVE" },
        { authorization: `Bearer ${requester}` },
      );
      expect(decide.status).toBe(403);
      expect(errorOf(decide)).toMatchObject({ code: "TOOL_UNAUTHORIZED", expected: "approver" });
      expect((await store.proposals.findById(DEMO, proposalId))?.status).toBe("AWAITING_APPROVAL");
      expect(await store.approvals.findByProposalId(DEMO, proposalId)).toBeNull();
    });

    it("does not issue demo sessions unless the composition root is a demo", async () => {
      const reply = await api("GET", "/auth/demo-session", undefined, { authorization: "" });
      expect(reply.status).toBe(404);
      expect(errorOf(reply).nextStep).toContain("pnpm run token");
    });

    it("with maker-checker on, the person who submitted the change cannot approve it", async () => {
      await server.close();
      const hub = createNotificationHub();
      const repositories = withProposalNotifications(store, hub, clock);
      server = createApiServer({
        repositories,
        tracker,
        queue,
        hub,
        clock,
        ids: sequentialIds(),
        context: { actor: { type: "USER", id: "api-user" }, allowedProductionIds: [DEMO] },
        identity: createLocalIdentity({ secret: SECRET, clock }),
        makerChecker: true,
      });
      base = (await server.listen(0)).url;

      const proposalId = await proposeViaRest();

      const own = await api("POST", `/productions/${DEMO}/proposals/${proposalId}/decision`, {
        decision: "APPROVE",
      });
      expect(own.status).toBe(403);
      expect(errorOf(own).message).toContain("a decision needs a second person");

      const second = tokenFor(principal("mina@example.test", { productions: [DEMO] }));
      const other = await api(
        "POST",
        `/productions/${DEMO}/proposals/${proposalId}/decision`,
        { decision: "APPROVE" },
        { authorization: `Bearer ${second}` },
      );
      expect(other.status).toBe(200);
      expect((other.body as { approval: { approvedBy: string } }).approval.approvedBy).toBe(
        "mina@example.test",
      );
    });

    it("refuses a WebSocket upgrade without a token, before any socket exists", async () => {
      const refused = new WebSocket(websocketUrl);
      const error = await new Promise<Error>((resolve) => refused.once("error", resolve));
      expect(error.message).toContain("401");

      // A browser-style connection sends its Origin (TASK-916); the token is still what fails here.
      const wrong = new WebSocket(`${websocketUrl}?access_token=pca1.forged.forged`, {
        headers: { origin: base },
      });
      expect(
        (await new Promise<Error>((resolve) => wrong.once("error", resolve))).message,
      ).toContain("401");

      // A subscription needs the token's grant, not only the server's allow-list.
      const elsewhere = tokenFor(principal("other@example.test", { productions: ["PROD-OTHER"] }));
      const socket = new WebSocket(websocketUrl, {
        headers: { authorization: `Bearer ${elsewhere}` },
      });
      const replies: unknown[] = [];
      socket.on("message", (raw) => replies.push(JSON.parse(rawDataToText(raw))));
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
      socket.send(JSON.stringify({ type: "subscribe", productionId: DEMO }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replies).toEqual([
        expect.objectContaining({ type: "welcome" }),
        expect.objectContaining({ type: "error", code: "PRODUCTION_UNAUTHORIZED" }),
      ]);
      socket.close();
    });
  });

  describe("origin policy (TASK-916, SEC-003 / AUD-007)", () => {
    const upgrade = (query: string, headers: Record<string, string>) =>
      new Promise<{ status: number | null; error: string | null }>((resolve) => {
        const socket = new WebSocket(`${websocketUrl}${query}`, { headers });
        socket.once("unexpected-response", (_request, response) => {
          resolve({ status: response.statusCode ?? null, error: null });
          socket.terminate();
        });
        socket.once("error", (error) => resolve({ status: null, error: error.message }));
        socket.once("open", () => {
          resolve({ status: 101, error: null });
          socket.close();
        });
      });

    it("refuses a foreign Origin with 403 before any socket exists, whatever the token", async () => {
      const foreign = await upgrade(`?access_token=${JINHO_TOKEN}`, {
        origin: "http://evil.example",
      });
      expect(foreign.status).toBe(403);
      const foreignHeader = await upgrade("", {
        origin: "http://evil.example",
        authorization: `Bearer ${JINHO_TOKEN}`,
      });
      expect(foreignHeader.status).toBe(403);
      const nullOrigin = await upgrade(`?access_token=${JINHO_TOKEN}`, { origin: "null" });
      expect(nullOrigin.status).toBe(403);
    });

    it("accepts the server's own origin and a listed origin", async () => {
      expect((await upgrade(`?access_token=${JINHO_TOKEN}`, { origin: base })).status).toBe(101);
      expect(
        (await upgrade(`?access_token=${JINHO_TOKEN}`, { origin: "http://localhost:4200" })).status,
      ).toBe(101);
    });

    it("requires an Origin when the token rides the query string, not when it is a header", async () => {
      expect((await upgrade(`?access_token=${JINHO_TOKEN}`, {})).status).toBe(403);
      expect((await upgrade("", { authorization: `Bearer ${JINHO_TOKEN}` })).status).toBe(101);
    });

    it("still answers a missing or bad token with 401 once the Origin is acceptable", async () => {
      expect((await upgrade("", { origin: base })).status).toBe(401);
      expect((await upgrade("?access_token=pca1.forged.forged", { origin: base })).status).toBe(
        401,
      );
    });
  });

  describe("demo mode (TASK-914)", () => {
    it("hands out the demo coordinator's token, which then works for REST and the socket", async () => {
      await server.close();
      const hub = createNotificationHub();
      const repositories = withProposalNotifications(store, hub, clock);
      const demoSecret = "demo-ephemeral-secret-".padEnd(32, "z");
      const demo = principal("demo-coordinator", { issuer: "pca-demo" });
      server = createApiServer({
        repositories,
        tracker,
        queue,
        hub,
        clock,
        ids: sequentialIds(),
        context: { actor: { type: "USER", id: "api-user" }, allowedProductionIds: "*" },
        identity: createLocalIdentity({ secret: demoSecret, clock }),
        demoSession: () => issueToken({ secret: demoSecret, principal: demo, clock }),
        makerChecker: false,
      });
      const bound = await server.listen(0);
      base = bound.url;

      const session = await api("GET", "/auth/demo-session", undefined, { authorization: "" });
      expect(session.status).toBe(200);
      expect(session.headers.get("cache-control")).toBe("no-store");
      const { token, principal: issued } = session.body as { token: string; principal: Principal };
      expect(issued).toEqual(demo);

      const read = await api("GET", `/productions/${DEMO}`, undefined, {
        authorization: `Bearer ${token}`,
      });
      expect(read.status).toBe(200);

      const socket = new WebSocket(`${bound.websocketUrl}?access_token=${token}`, {
        headers: { origin: bound.url },
      });
      const first = await new Promise<unknown>((resolve) =>
        socket.once("message", (raw) => resolve(JSON.parse(rawDataToText(raw)))),
      );
      expect(first).toMatchObject({ type: "welcome" });
      socket.close();
    });
  });

  describe("websocket on the same server", () => {
    it("greets on /ws and delivers a job event for a subscribed production", async () => {
      const socket = new WebSocket(`${websocketUrl}?access_token=${JINHO_TOKEN}`, {
        headers: { origin: base },
      });
      const messages: unknown[] = [];
      const waiters: ((message: unknown) => void)[] = [];
      socket.on("message", (raw) => {
        const message: unknown = JSON.parse(rawDataToText(raw));
        const waiter = waiters.shift();
        if (waiter === undefined) messages.push(message);
        else waiter(message);
      });
      const next = () =>
        new Promise<unknown>((resolve) => {
          const queued = messages.shift();
          if (queued !== undefined) resolve(queued);
          else waiters.push(resolve);
        });
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
      expect(await next()).toMatchObject({ type: "welcome", canonicalSource: "rest" });
      socket.send(JSON.stringify({ type: "subscribe", productionId: DEMO }));
      expect(await next()).toEqual({ type: "subscribed", productionId: DEMO });
      await api("POST", `/productions/${DEMO}/changes`, { text: "Sarah cannot shoot Friday." });
      expect(await next()).toMatchObject({
        type: "job",
        event: { stage: "received", status: "STARTED" },
      });

      socket.send(JSON.stringify({ type: "subscribe", productionId: "PROD-OTHER" }));
      expect(await next()).toMatchObject({ type: "error", code: "PRODUCTION_UNAUTHORIZED" });
      socket.close();
    });
  });
});
