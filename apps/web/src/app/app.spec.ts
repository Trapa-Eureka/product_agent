import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { App } from "./app";
import { routes } from "./app.routes";
import { RealtimeService } from "./realtime/realtime.service";
import { NAV_ENTRIES } from "./shell/production-nav";
import { ProductionStore } from "./state/production.store";

/** Waits for an async store update instead of guessing how many ticks it takes. */
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the store");
};

const productionBody = { id: "PROD-DEMO", name: "Demo Movie", timezone: "Asia/Manila", version: 1 };

describe("App shell", () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter(routes),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: RealtimeService,
          useValue: {
            connect: () => undefined,
            follow: () => undefined,
            status: () => "idle",
            view: () => null,
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  it("renders the header with the production name and version, the nav, and the workspace", async () => {
    const harness = await RouterTestingHarness.create();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    await harness.navigateByUrl("/productions/PROD-DEMO");
    http.expectOne("/api/productions/PROD-DEMO").flush(productionBody);
    await until(() => TestBed.inject(ProductionStore).loadState() !== "loading");
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Production:");
    expect(text).toContain("Demo Movie");
    expect(text).toContain("Version 1");
    expect(text).toContain("Not connected");
    for (const entry of NAV_ENTRIES) expect(text).toContain(entry.label);
    expect(text).toContain("Change Workspace");
    expect(text).toContain("What is affected?");
    http.verify();
  });

  it("shows the server's error code and next step when the production cannot be loaded", async () => {
    const harness = await RouterTestingHarness.create();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    await harness.navigateByUrl("/productions/PROD-NOPE");
    http.expectOne("/api/productions/PROD-NOPE").flush(
      {
        error: {
          code: "TOOL_UNAUTHORIZED",
          message: "This server is not permitted to act on production PROD-NOPE.",
          nextStep: "Use a production this server was started for.",
        },
      },
      { status: 403, statusText: "Forbidden" },
    );
    await until(() => TestBed.inject(ProductionStore).loadState() !== "loading");
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("TOOL_UNAUTHORIZED");
    expect(text).toContain("Use a production this server was started for.");
  });
});
