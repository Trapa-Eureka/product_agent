import { HttpClient, provideHttpClient, withInterceptors } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { firstValueFrom } from "rxjs";
import { beforeEach, describe, expect, it } from "vitest";

import { authInterceptor } from "./auth.interceptor";
import { AuthService, DEMO_SESSION_PATH } from "./auth.service";

describe("authInterceptor (TASK-914)", () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  it("adds the bearer token to API requests and to nothing else", async () => {
    auth.useToken("pca1.a.b");
    const api = firstValueFrom(http.get("/api/productions/PROD-DEMO"));
    backend.expectOne("/api/productions/PROD-DEMO").flush({ id: "PROD-DEMO" });
    await api;
    const other = firstValueFrom(http.get("/assets/x.json"));
    const outside = backend.expectOne("/assets/x.json");
    expect(outside.request.headers.has("Authorization")).toBe(false);
    outside.flush({});
    await other;
    // The one API call made without a token: fetching the demo session itself.
    const demo = firstValueFrom(http.get(DEMO_SESSION_PATH));
    const session = backend.expectOne(DEMO_SESSION_PATH);
    expect(session.request.headers.has("Authorization")).toBe(false);
    session.flush({});
    await demo;
  });

  it("sends the header value the API expects", () => {
    auth.useToken("pca1.a.b");
    void firstValueFrom(http.get("/api/productions/PROD-DEMO")).catch(() => undefined);
    expect(
      backend.expectOne("/api/productions/PROD-DEMO").request.headers.get("Authorization"),
    ).toBe("Bearer pca1.a.b");
  });

  it("clears the session on a 401 so the shell asks for another token", async () => {
    auth.useToken("pca1.expired");
    const failing = firstValueFrom(http.get("/api/productions/PROD-DEMO")).catch(
      (error: unknown) => error,
    );
    backend
      .expectOne("/api/productions/PROD-DEMO")
      .flush(
        { error: { code: "UNAUTHENTICATED", message: "The access token has expired." } },
        { status: 401, statusText: "Unauthorized" },
      );
    await failing;
    expect(auth.state()).toBe("needs-token");
    expect(auth.token()).toBeNull();
  });
});
