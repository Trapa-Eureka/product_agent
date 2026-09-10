import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { JobRun, TypedChange } from "@pca/contracts";

import { AmbiguityResolution } from "./ambiguity-resolution";
import { ChangeSubmissionService } from "./change-submission.service";

const T0 = "2026-09-10T12:00:00.000Z";

const resolvingJob: JobRun = {
  id: "JOB-1",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  type: "ANALYZE_CHANGE",
  stage: "resolving",
  status: "STARTED",
  message: "The sentence could refer to more than one person or place. Which one?",
  options: [
    {
      label: "Sarah",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: "CAST-SARAH",
        unavailable: { start: "2026-09-18", end: "2026-09-18" },
      },
    },
    {
      label: "Sarah",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: "CAST-SARAH-2",
        unavailable: { start: "2026-09-18", end: "2026-09-18" },
      },
    },
  ],
  history: [],
  createdAt: T0,
  updatedAt: T0,
};

type FakeSubmission = {
  job: ReturnType<typeof signal<JobRun | null>>;
  state: ReturnType<typeof signal<"idle" | "submitting" | "error">>;
  resolve: (productionId: string, change: TypedChange) => Promise<void>;
};

const render = (fake: FakeSubmission) => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ChangeSubmissionService, useValue: fake },
    ],
  });
  const fixture = TestBed.createComponent(AmbiguityResolution);
  fixture.componentRef.setInput("productionId", "PROD-DEMO");
  fixture.detectChanges();
  return fixture;
};

describe("AmbiguityResolution", () => {
  it("shows nothing when there is no job at resolving", () => {
    const fixture = render({
      job: signal(null),
      state: signal("idle"),
      resolve: () => Promise.resolve(),
    });
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe("");
  });

  it("shows nothing once the job has moved past resolving, even if options linger on the record", () => {
    const fixture = render({
      job: signal({ ...resolvingJob, stage: "analyzing" }),
      state: signal("idle"),
      resolve: () => Promise.resolve(),
    });
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe("");
  });

  it("renders the question and every option, each with a distinguishing detail beneath a repeated label", () => {
    const fixture = render({
      job: signal(resolvingJob),
      state: signal("idle"),
      resolve: () => Promise.resolve(),
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Which one?");
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain("Sarah");
    expect(buttons[0]?.textContent).toContain("CAST-SARAH");
    expect(buttons[0]?.textContent).not.toContain("CAST-SARAH-2");
    expect(buttons[1]?.textContent).toContain("CAST-SARAH-2");
  });

  it("resolves with the chosen option's change when clicked", () => {
    const calls: [string, TypedChange][] = [];
    const fixture = render({
      job: signal(resolvingJob),
      state: signal("idle"),
      resolve: (productionId, change) => {
        calls.push([productionId, change]);
        return Promise.resolve();
      },
    });
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll("button")];
    (buttons[1] as HTMLButtonElement).click();
    expect(calls).toEqual([["PROD-DEMO", resolvingJob.options?.[1]?.change]]);
  });

  it("disables the options while a resolution is in flight", () => {
    const fixture = render({
      job: signal(resolvingJob),
      state: signal("submitting"),
      resolve: () => Promise.resolve(),
    });
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll("button")];
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});
