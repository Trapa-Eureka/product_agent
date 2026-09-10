import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError, ProductionApi } from "./production-api";

describe("ProductionApi", () => {
  let api: ProductionApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ProductionApi);
    http = TestBed.inject(HttpTestingController);
  });

  it("reads a production from its route", async () => {
    const pending = api.getProduction("PROD-DEMO");
    http
      .expectOne("/api/productions/PROD-DEMO")
      .flush({ id: "PROD-DEMO", name: "Demo Movie", timezone: "Asia/Manila", version: 1 });
    expect((await pending).name).toBe("Demo Movie");
  });

  it("turns the server's ToolError body into an ApiError with status and code", async () => {
    const pending = api.getProduction("PROD-NOPE");
    http.expectOne("/api/productions/PROD-NOPE").flush(
      {
        error: {
          code: "TOOL_UNAUTHORIZED",
          message: "Not permitted.",
          nextStep: "Ask an operator.",
        },
      },
      { status: 403, statusText: "Forbidden" },
    );
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      status: 403,
      error: { code: "TOOL_UNAUTHORIZED" },
    });
  });

  it("posts a change and reads the job back", async () => {
    const pending = api.submitChange("PROD-DEMO", { text: "Sarah cannot shoot Friday." });
    const request = http.expectOne("/api/productions/PROD-DEMO/changes");
    expect(request.request.method).toBe("POST");
    expect(request.request.body).toEqual({ text: "Sarah cannot shoot Friday." });
    request.flush({ job: { id: "JOB-1" } });
    expect((await pending).job.id).toBe("JOB-1");
  });

  it("resumes a job by posting the chosen change and its jobId", async () => {
    const change = {
      type: "CAST_UNAVAILABLE" as const,
      castId: "CAST-SARAH",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    };
    const pending = api.submitChange("PROD-DEMO", {
      text: "Sarah cannot shoot Friday.",
      change,
      jobId: "JOB-1",
    });
    const request = http.expectOne("/api/productions/PROD-DEMO/changes");
    expect(request.request.body).toEqual({
      text: "Sarah cannot shoot Friday.",
      change,
      jobId: "JOB-1",
    });
    request.flush({ job: { id: "JOB-1" } });
    await pending;
  });

  it("reads a change request by ID", async () => {
    const pending = api.getChangeRequest("PROD-DEMO", "CR-1");
    http
      .expectOne("/api/productions/PROD-DEMO/change-requests/CR-1")
      .flush({ id: "CR-1", type: "CAST_UNAVAILABLE" });
    expect((await pending).id).toBe("CR-1");
  });

  it("posts a change to the impact-explanation route and reads the panel back", async () => {
    const change = {
      type: "CAST_UNAVAILABLE" as const,
      castId: "CAST-SARAH",
      unavailable: { start: "2026-09-18", end: "2026-09-18" },
    };
    const pending = api.getImpactExplanation("PROD-DEMO", change);
    const request = http.expectOne("/api/productions/PROD-DEMO/analysis/explanation");
    expect(request.request.method).toBe("POST");
    expect(request.request.body).toEqual({ change });
    request.flush({
      blocking: ["2 scheduled scenes conflict with Sarah's availability."],
      affected: {
        scenes: ["07", "12"],
        shootDays: [],
        callSheets: [],
        tasks: [],
        castMembers: [],
        locations: [],
      },
      why: ["Scene 07 requires Sarah and is scheduled Fri Sep 18."],
    });
    expect((await pending).blocking).toHaveLength(1);
  });
});
