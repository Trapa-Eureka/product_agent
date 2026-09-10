import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { JobRun, ToolError } from "@pca/contracts";

import { ProductionStore } from "../state/production.store";
import { ChangeSubmissionService } from "./change-submission.service";
import { ChangeWorkspace } from "./change-workspace";

const T0 = "2026-09-10T12:00:00.000Z";

const awaitingApprovalJob: JobRun = {
  id: "JOB-1",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  type: "ANALYZE_CHANGE",
  stage: "awaiting_approval",
  status: "STARTED",
  proposalId: "P-1",
  explanation: {
    headline: "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    effects: [{ tone: "ATTENTION", text: "Call sheet Fri Sep 18 must be regenerated" }],
    operations: ["record Sarah unavailable Fri Sep 18"],
  },
  history: [],
  createdAt: T0,
  updatedAt: T0,
};

/** Everything `ChangeWorkspace` and the panels it renders read from `ChangeSubmissionService`. */
const fakeSubmission = (job: JobRun | null) => {
  const rejectCalls: string[] = [];
  const approveCalls: string[] = [];
  return {
    job: signal<JobRun | null>(job),
    changeRequest: signal(null),
    impactExplanation: signal(null),
    state: signal<"idle" | "submitting" | "error">("idle"),
    error: signal<ToolError | null>(null),
    reset: () => undefined,
    submit: () => Promise.resolve(),
    resolve: () => Promise.resolve(),
    reject: (productionId: string) => {
      rejectCalls.push(productionId);
      return Promise.resolve();
    },
    approveAndApply: (productionId: string) => {
      approveCalls.push(productionId);
      return Promise.resolve();
    },
    rejectCalls,
    approveCalls,
  };
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const render = (fake: ReturnType<typeof fakeSubmission>, productionId = "PROD-DEMO") => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ProductionStore,
        useValue: { productionId: signal(productionId), openJobs: signal([]), version: signal(1) },
      },
    ],
  });
  // ChangeWorkspace declares ChangeSubmissionService in its own component providers
  // (TASK-502), so a root-level fake would be shadowed; override the component's own.
  TestBed.overrideComponent(ChangeWorkspace, {
    set: { providers: [{ provide: ChangeSubmissionService, useValue: fake }] },
  });
  const fixture = TestBed.createComponent(ChangeWorkspace);
  fixture.detectChanges();
  return fixture;
};

const buttons = (root: HTMLElement) => [...root.querySelectorAll(".actions button")];

describe("ChangeWorkspace approval actions (TASK-505)", () => {
  it("disables Reject and Approve & Apply, and shows no confirmation, without a job awaiting approval", () => {
    const fixture = render(fakeSubmission(null));
    const root = fixture.nativeElement as HTMLElement;
    const [reject, approve] = buttons(root);
    expect(reject?.textContent).toContain("Reject");
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelector(".confirmation")).toBeNull();
  });

  it("enables the actions once a job is awaiting approval", () => {
    const fixture = render(fakeSubmission(awaitingApprovalJob));
    const root = fixture.nativeElement as HTMLElement;
    const [reject, approve] = buttons(root);
    expect((reject as HTMLButtonElement).disabled).toBe(false);
    expect((approve as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking Approve & Apply opens the DESIGN.md §5 confirmation with the proposal summary", () => {
    const fixture = render(fakeSubmission(awaitingApprovalJob));
    const root = fixture.nativeElement as HTMLElement;
    (buttons(root)[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    const confirmation = root.querySelector(".confirmation");
    expect(confirmation?.textContent).toContain(
      "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    );
    expect(confirmation?.textContent).toContain("Approving will change the production plan.");
  });

  it("clicking Reject calls submission.reject with the open production", () => {
    const fake = fakeSubmission(awaitingApprovalJob);
    const fixture = render(fake);
    const root = fixture.nativeElement as HTMLElement;
    (buttons(root)[0] as HTMLButtonElement).click();
    expect(fake.rejectCalls).toEqual(["PROD-DEMO"]);
  });

  it("confirming calls submission.approveAndApply and then closes the confirmation", async () => {
    const fake = fakeSubmission(awaitingApprovalJob);
    const fixture = render(fake);
    const root = fixture.nativeElement as HTMLElement;
    (buttons(root)[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    (root.querySelector(".confirmation button.primary") as HTMLButtonElement).click();
    await settle();
    fixture.detectChanges();

    expect(fake.approveCalls).toEqual(["PROD-DEMO"]);
    expect(root.querySelector(".confirmation")).toBeNull();
  });

  it("cancelling closes the confirmation without deciding anything", () => {
    const fake = fakeSubmission(awaitingApprovalJob);
    const fixture = render(fake);
    const root = fixture.nativeElement as HTMLElement;
    (buttons(root)[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    const [cancel] = [...root.querySelectorAll(".confirmation button")];
    (cancel as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(root.querySelector(".confirmation")).toBeNull();
    expect(fake.approveCalls).toEqual([]);
    expect(fake.rejectCalls).toEqual([]);
  });

  it("TASK-506: wires the tracked job into the progress timeline panel", () => {
    const fixture = render(fakeSubmission(awaitingApprovalJob));
    const root = fixture.nativeElement as HTMLElement;
    const progress = root.querySelector('[data-panel="progress"]');
    expect(progress?.textContent).toContain("Waiting for approval");
  });

  it("resets a stale confirming flag for a different job, so it does not reopen unasked", async () => {
    const fake = fakeSubmission(awaitingApprovalJob);
    const fixture = render(fake);
    const root = fixture.nativeElement as HTMLElement;
    (buttons(root)[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector(".confirmation")).not.toBeNull();

    fake.job.set({ ...awaitingApprovalJob, id: "JOB-2", proposalId: "P-2" });
    await settle();
    fixture.detectChanges();

    expect(root.querySelector(".confirmation")).toBeNull();
  });
});
