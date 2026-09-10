import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { JobRun } from "@pca/contracts";

import { ProductionStore } from "../state/production.store";
import { ApprovalConfirmation } from "./approval-confirmation";
import { ChangeSubmissionService } from "./change-submission.service";

const job: JobRun = {
  id: "JOB-1",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  type: "ANALYZE_CHANGE",
  stage: "awaiting_approval",
  status: "STARTED",
  proposalId: "P-1",
  explanation: {
    headline: "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    effects: [
      { tone: "POSITIVE", text: "resolves Sarah conflict on Scene 07 and Scene 12" },
      { tone: "ATTENTION", text: "Call sheet Fri Sep 18 must be regenerated" },
      { tone: "ATTENTION", text: "John is required Tue Sep 22" },
    ],
    operations: [
      "record Sarah unavailable Fri Sep 18",
      "remove Scene 07 from Fri Sep 18",
      "add Scene 07 to Tue Sep 22",
      "mark Call sheet Fri Sep 18 for regeneration",
    ],
  },
  history: [],
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
};

const render = (
  options: {
    job?: JobRun;
    state?: "idle" | "submitting" | "error";
    version?: number | null;
  } = {},
) => {
  const approveCalls: string[] = [];
  const fakeSubmission = {
    job: signal<JobRun | null>(options.job ?? job),
    state: signal(options.state ?? "idle"),
    approveAndApply: (productionId: string) => {
      approveCalls.push(productionId);
      return Promise.resolve();
    },
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ChangeSubmissionService, useValue: fakeSubmission },
      {
        provide: ProductionStore,
        useValue: { version: signal(options.version === undefined ? 1 : options.version) },
      },
    ],
  });
  const fixture = TestBed.createComponent(ApprovalConfirmation);
  fixture.componentRef.setInput("productionId", "PROD-DEMO");
  fixture.detectChanges();
  return { fixture, approveCalls };
};

const ddValues = (root: HTMLElement): (string | null)[] =>
  [...root.querySelectorAll("dd")].map((el) => el.textContent);

describe("ApprovalConfirmation", () => {
  it("DESIGN.md §5: shows the proposal summary, operation count, current version, and the explicit notice", () => {
    const { fixture } = render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector(".summary")?.textContent).toBe(
      "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    );
    expect(ddValues(root)).toEqual(["4", "1"]);
    expect(root.textContent).toContain("Approving will change the production plan.");
  });

  it("lists only the ATTENTION effects as warnings, not the POSITIVE ones", () => {
    const { fixture } = render();
    const root = fixture.nativeElement as HTMLElement;
    const warnings = [...root.querySelectorAll(".warnings li")].map((el) => el.textContent);
    expect(warnings).toEqual([
      "Call sheet Fri Sep 18 must be regenerated",
      "John is required Tue Sep 22",
    ]);
    expect(root.textContent).not.toContain("resolves Sarah conflict");
  });

  it("omits the Warnings section when there are none", () => {
    const { fixture } = render({
      job: {
        ...job,
        explanation: { headline: job.explanation?.headline ?? "", effects: [], operations: ["x"] },
      },
    });
    expect((fixture.nativeElement as HTMLElement).querySelector(".warnings")).toBeNull();
  });

  it("shows an em dash when the production version is not yet known", () => {
    const { fixture } = render({ version: null });
    expect(ddValues(fixture.nativeElement as HTMLElement)).toEqual(["4", "—"]);
  });

  it("confirming calls approveAndApply with the production ID and then emits closed", async () => {
    const emitted: void[] = [];
    const { fixture, approveCalls } = render();
    fixture.componentInstance.closed.subscribe(() => emitted.push(undefined));
    const primary = (fixture.nativeElement as HTMLElement).querySelector(
      "button.primary",
    ) as HTMLButtonElement;
    primary.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(approveCalls).toEqual(["PROD-DEMO"]);
    expect(emitted).toHaveLength(1);
  });

  it("cancelling emits closed without calling approveAndApply", () => {
    const emitted: void[] = [];
    const { fixture, approveCalls } = render();
    fixture.componentInstance.closed.subscribe(() => emitted.push(undefined));
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll("button")];
    (buttons[0] as HTMLButtonElement).click();
    expect(emitted).toHaveLength(1);
    expect(approveCalls).toEqual([]);
  });

  it("disables the confirm button and says Applying… while submitting", () => {
    const { fixture } = render({ state: "submitting" });
    const primary = (fixture.nativeElement as HTMLElement).querySelector(
      "button.primary",
    ) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).toContain("Applying");
  });
});
