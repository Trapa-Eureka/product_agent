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
});
