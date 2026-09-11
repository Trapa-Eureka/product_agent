import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthService, DEMO_SESSION_PATH } from "./auth.service";

const principal = {
  subject: "demo-coordinator",
  issuer: "pca-demo",
  type: "USER",
  roles: ["approver"],
  productions: "*",
} as const;

describe("AuthService (TASK-914)", () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it("takes the server's demo session and remembers it for this tab", async () => {
    const pending = service.ensureSession();
    const request = http.expectOne(DEMO_SESSION_PATH);
    expect(request.request.method).toBe("GET");
    expect(request.request.headers.has("Authorization")).toBe(false);
    request.flush({ token: "pca1.demo.token", principal });
    await pending;
    expect(service.state()).toBe("ready");
    expect(service.token()).toBe("pca1.demo.token");
    expect(service.principal()).toEqual(principal);
    expect(sessionStorage.getItem("pca.accessToken")).toBe("pca1.demo.token");
  });

  it("asks for a token when the server issues no demo session", async () => {
    const pending = service.ensureSession();
    http.expectOne(DEMO_SESSION_PATH).flush(
      {
        error: { code: "ENTITY_NOT_FOUND", message: "This server does not issue demo sessions." },
      },
      { status: 404, statusText: "Not Found" },
    );
    await pending;
    expect(service.state()).toBe("needs-token");
    expect(service.token()).toBeNull();

    service.useToken("  pca1.pasted.token  ");
    expect(service.state()).toBe("ready");
    expect(service.token()).toBe("pca1.pasted.token");
    expect(sessionStorage.getItem("pca.accessToken")).toBe("pca1.pasted.token");
  });

  it("reuses a stored token without asking the server, and forgets it when cleared", async () => {
    sessionStorage.setItem("pca.accessToken", "pca1.stored.token");
    await service.ensureSession();
    http.expectNone(DEMO_SESSION_PATH);
    expect(service.state()).toBe("ready");
    expect(service.token()).toBe("pca1.stored.token");

    service.clear();
    expect(service.state()).toBe("needs-token");
    expect(service.token()).toBeNull();
    expect(sessionStorage.getItem("pca.accessToken")).toBeNull();
  });

  it("ignores an empty pasted token", () => {
    service.useToken("   ");
    expect(service.state()).toBe("unknown");
    expect(service.token()).toBeNull();
  });
});
