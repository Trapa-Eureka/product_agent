import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { JobRun } from "@pca/contracts";
import type { ProductionView } from "@pca/realtime-client";

import { RealtimeService } from "../realtime/realtime.service";
import { ChangeSubmissionService } from "./change-submission.service";

const DEMO = "PROD-DEMO";
const T0 = "2026-09-10T12:00:00.000Z";
const T1 = "2026-09-10T12:00:05.000Z";

const receivedJob: JobRun = {
  id: "JOB-1",
  productionId: DEMO,
  correlationId: "corr-1",
  type: "ANALYZE_CHANGE",
  stage: "received",
  status: "STARTED",
  history: [],
  createdAt: T0,
  updatedAt: T0,
};

// No changeRequestId: submit()'s change-request/impact-explanation follow-up
// fetches are exercised by the cascade test above; these tests are only
// about the decision/apply calls, so nothing else should fire.
const awaitingApprovalJob: JobRun = {
  ...receivedJob,
  stage: "awaiting_approval",
  proposalId: "P-1",
  explanation: {
    headline: "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    effects: [],
    operations: ["x"],
  },
};

/** Waits for the microtask queue to drain so an async continuation past an HTTP flush runs. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ChangeSubmissionService", () => {
  let http: HttpTestingController;
  let service: ChangeSubmissionService;
  let view: ReturnType<typeof signal<ProductionView | null>>;

  beforeEach(() => {
    view = signal<ProductionView | null>(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        ChangeSubmissionService,
        { provide: RealtimeService, useValue: { view } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ChangeSubmissionService);
  });

  it("submits a sentence and stores the returned job and text", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    const request = http.expectOne(`/api/productions/${DEMO}/changes`);
    expect(request.request.body).toEqual({ text: "Sarah cannot shoot Friday." });
    request.flush({ job: receivedJob });
    await pending;

    expect(service.job()).toEqual(receivedJob);
    expect(service.originalText()).toBe("Sarah cannot shoot Friday.");
    expect(service.state()).toBe("idle");
    expect(service.error()).toBeNull();
  });

  it("carries the server's error into state and error, and leaves no job", async () => {
    const pending = service.submit(DEMO, "Make it better.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush(
      {
        error: {
          code: "UNSUPPORTED_CHANGE",
          message: "This sentence does not name a supported change.",
        },
      },
      { status: 422, statusText: "Unprocessable Entity" },
    );
    await pending;

    expect(service.state()).toBe("error");
    expect(service.error()).toEqual({
      code: "UNSUPPORTED_CHANGE",
      message: "This sentence does not name a supported change.",
    });
    expect(service.job()).toBeNull();
  });

  it("resolve resubmits the stored text and the tracked job's ID with the chosen change", async () => {
    const submitted = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({
      job: { ...receivedJob, stage: "resolving", message: "Which one? Sarah or Sarah?" },
    });
    await submitted;

    const change = {
      type: "CAST_UNAVAILABLE" as const,
      castId: "CAST-SARAH",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    };
    const resolved = service.resolve(DEMO, change);
    const request = http.expectOne(`/api/productions/${DEMO}/changes`);
    expect(request.request.body).toEqual({
      text: "Sarah cannot shoot Friday.",
      change,
      jobId: "JOB-1",
    });
    request.flush({ job: { ...receivedJob, stage: "resolving" } });
    await resolved;
    expect(service.state()).toBe("idle");
  });

  it("does nothing when asked to resolve without a job in flight", async () => {
    await service.resolve(DEMO, {
      type: "CAST_UNAVAILABLE",
      castId: "CAST-SARAH",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    });
    http.verify();
    expect(service.job()).toBeNull();
  });

  it("a live event for the tracked job re-reads it over REST, loads the change request, then the impact panel", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({ job: receivedJob });
    await pending;

    // The notification channel only says "something changed"; it carries no job details.
    view.set({
      productionId: DEMO,
      productionVersion: 1,
      jobs: [{ ...receivedJob, stage: "awaiting_approval", updatedAt: T1 }],
      openProposals: [],
      recoveredAt: T1,
      recovering: false,
    });
    await settle();

    http.expectOne(`/api/productions/${DEMO}/jobs/JOB-1`).flush({
      ...receivedJob,
      stage: "awaiting_approval",
      changeRequestId: "CR-1",
      updatedAt: T1,
    });
    await settle();

    expect(service.job()?.stage).toBe("awaiting_approval");

    const change = {
      type: "CAST_UNAVAILABLE" as const,
      castId: "CAST-SARAH",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    };
    http
      .expectOne(`/api/productions/${DEMO}/change-requests/CR-1`)
      .flush({ id: "CR-1", type: "CAST_UNAVAILABLE", payload: change });
    await settle();

    expect(service.changeRequest()?.id).toBe("CR-1");

    const explanationRequest = http.expectOne(`/api/productions/${DEMO}/analysis/explanation`);
    expect(explanationRequest.request.body).toEqual({ change });
    explanationRequest.flush({
      blocking: ["2 scheduled scenes conflict with Sarah's availability."],
      affected: {
        scenes: ["07", "12"],
        shootDays: [],
        callSheets: [],
        tasks: [],
        castMembers: [],
        locations: [],
      },
      why: [],
    });
    await settle();

    expect(service.impactExplanation()?.blocking).toEqual([
      "2 scheduled scenes conflict with Sarah's availability.",
    ]);
  });

  it("ignores a live event that does not change anything about the job it already has", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({ job: receivedJob });
    await pending;

    view.set({
      productionId: DEMO,
      productionVersion: 1,
      jobs: [receivedJob],
      openProposals: [],
      recoveredAt: T0,
      recovering: false,
    });
    await settle();
    http.verify();
  });

  it("reject decides REJECT with the job ID, then re-reads the job so completion shows immediately", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({ job: awaitingApprovalJob });
    await pending;

    const rejected = service.reject(DEMO);
    const decision = http.expectOne(`/api/productions/${DEMO}/proposals/P-1/decision`);
    expect(decision.request.body).toEqual({ decision: "REJECT", jobId: "JOB-1" });
    decision.flush({
      approval: { id: "A-1", decision: "REJECT" },
      proposal: { id: "P-1", status: "REJECTED" },
      alreadyDecided: false,
    });
    await settle();

    http.expectOne(`/api/productions/${DEMO}/jobs/JOB-1`).flush({
      ...awaitingApprovalJob,
      stage: "completed",
      status: "COMPLETED",
      message: "Rejected; nothing will change.",
    });
    await rejected;

    expect(service.job()?.stage).toBe("completed");
    expect(service.state()).toBe("idle");
  });

  it("does nothing when asked to reject or approve without a decidable job", async () => {
    await service.reject(DEMO);
    await service.approveAndApply(DEMO);
    http.verify();
    expect(service.job()).toBeNull();
  });

  it("approveAndApply approves, then applies as a job with the approved baseProductionVersion", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({ job: awaitingApprovalJob });
    await pending;

    const approved = service.approveAndApply(DEMO);
    const decision = http.expectOne(`/api/productions/${DEMO}/proposals/P-1/decision`);
    expect(decision.request.body).toEqual({ decision: "APPROVE" });
    decision.flush({
      approval: { id: "A-1", decision: "APPROVE" },
      proposal: { id: "P-1", status: "APPROVED", baseProductionVersion: 1 },
      alreadyDecided: false,
    });
    await settle();

    const apply = http.expectOne(`/api/productions/${DEMO}/proposals/P-1/apply`);
    expect(apply.request.body).toMatchObject({
      approvalId: "A-1",
      expectedProductionVersion: 1,
      jobId: "JOB-1",
    });
    const idempotencyKey = (apply.request.body as { idempotencyKey: string }).idempotencyKey;
    expect(idempotencyKey.length).toBeGreaterThanOrEqual(8);
    apply.flush({ job: { ...awaitingApprovalJob, message: "Applying." } });
    await approved;

    expect(service.job()?.message).toBe("Applying.");
    expect(service.state()).toBe("idle");
  });

  it("approveAndApply carries the server's error and leaves the job untouched", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({ job: awaitingApprovalJob });
    await pending;

    const approved = service.approveAndApply(DEMO);
    http
      .expectOne(`/api/productions/${DEMO}/proposals/P-1/decision`)
      .flush(
        { error: { code: "PRODUCTION_VERSION_MISMATCH", message: "The production moved on." } },
        { status: 409, statusText: "Conflict" },
      );
    await approved;

    expect(service.state()).toBe("error");
    expect(service.error()).toEqual({
      code: "PRODUCTION_VERSION_MISMATCH",
      message: "The production moved on.",
    });
    expect(service.job()?.stage).toBe("awaiting_approval");
  });

  it("reset clears every field, ready for a fresh submission", async () => {
    const pending = service.submit(DEMO, "Sarah cannot shoot Friday.");
    http.expectOne(`/api/productions/${DEMO}/changes`).flush({ job: receivedJob });
    await pending;

    service.reset();
    expect(service.job()).toBeNull();
    expect(service.changeRequest()).toBeNull();
    expect(service.impactExplanation()).toBeNull();
    expect(service.originalText()).toBe("");
    expect(service.state()).toBe("idle");
    expect(service.error()).toBeNull();
  });
});
