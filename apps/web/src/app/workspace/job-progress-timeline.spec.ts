import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { JobRun } from "@pca/contracts";

import { JobProgressTimeline } from "./job-progress-timeline";

const T0 = "2026-09-10T12:00:00.000Z";

const render = (job: JobRun | null) => {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(JobProgressTimeline);
  fixture.componentRef.setInput("job", job);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
};

describe("JobProgressTimeline", () => {
  it("shows a placeholder without a job", () => {
    const root = render(null);
    expect(root.textContent).toContain("No job in progress.");
  });

  it("DESIGN.md §6: renders ✓/●/○ against every stage in order", () => {
    const root = render({
      id: "JOB-1",
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
      stage: "awaiting_approval",
      status: "STARTED",
      history: [
        {
          jobId: "JOB-1",
          productionId: "PROD-DEMO",
          correlationId: "corr-1",
          stage: "received",
          status: "COMPLETED",
          occurredAt: T0,
        },
        {
          jobId: "JOB-1",
          productionId: "PROD-DEMO",
          correlationId: "corr-1",
          stage: "awaiting_approval",
          status: "STARTED",
          occurredAt: T0,
        },
      ],
      createdAt: T0,
      updatedAt: T0,
    });
    const rows = [...root.querySelectorAll("li")];
    expect(rows).toHaveLength(8);
    expect(rows[0]?.getAttribute("data-status")).toBe("done");
    expect(rows[0]?.textContent).toContain("✓");
    expect(rows[0]?.textContent).toContain("Change received");
    expect(rows[5]?.getAttribute("data-status")).toBe("active");
    expect(rows[5]?.textContent).toContain("●");
    expect(rows[5]?.textContent).toContain("Waiting for approval");
    expect(rows[7]?.getAttribute("data-status")).toBe("pending");
    expect(rows[7]?.textContent).toContain("○");
    expect(rows[7]?.textContent).toContain("Verifying");
  });

  it("shows only the failed stage and its recovery message on failure", () => {
    const root = render({
      id: "JOB-1",
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
      stage: "failed",
      status: "FAILED",
      message: "STALE_VERSION: Production has moved to version 4.",
      history: [
        {
          jobId: "JOB-1",
          productionId: "PROD-DEMO",
          correlationId: "corr-1",
          stage: "applying",
          status: "FAILED",
          message: "STALE_VERSION: Production has moved to version 4.",
          occurredAt: T0,
        },
      ],
      createdAt: T0,
      updatedAt: T0,
    });
    expect(root.querySelectorAll("li")).toHaveLength(0);
    expect(root.textContent).toContain("Applying failed.");
    expect(root.textContent).toContain("STALE_VERSION: Production has moved to version 4.");
  });
});
