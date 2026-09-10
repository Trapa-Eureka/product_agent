import { describe, expect, it } from "vitest";

import type { AgentJobEvent, JobRun, JobStage } from "@pca/contracts";

import { buildJobProgress } from "./job-progress-format";

const T0 = "2026-09-10T12:00:00.000Z";

const evt = (
  stage: JobStage,
  status: AgentJobEvent["status"],
  message?: string,
): AgentJobEvent => ({
  jobId: "JOB-1",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  stage,
  status,
  occurredAt: T0,
  ...(message === undefined ? {} : { message }),
});

const job = (overrides: Partial<JobRun>): JobRun => ({
  id: "JOB-1",
  productionId: "PROD-DEMO",
  correlationId: "corr-1",
  type: "ANALYZE_CHANGE",
  stage: "received",
  status: "STARTED",
  history: [],
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const ALL_STAGES: readonly JobStage[] = [
  "received",
  "resolving",
  "analyzing",
  "simulating",
  "validating",
  "awaiting_approval",
  "applying",
  "verifying",
];

describe("buildJobProgress", () => {
  it("returns null without a job", () => {
    expect(buildJobProgress(null)).toBeNull();
  });

  it("marks only the current stage active on a fresh job", () => {
    const progress = buildJobProgress(job({ history: [evt("received", "STARTED")] }));
    expect(progress?.kind).toBe("steps");
    if (progress?.kind !== "steps") throw new Error("expected steps");
    expect(progress.steps.map((step) => [step.stage, step.status])).toEqual([
      ["received", "active"],
      ["resolving", "pending"],
      ["analyzing", "pending"],
      ["simulating", "pending"],
      ["validating", "pending"],
      ["awaiting_approval", "pending"],
      ["applying", "pending"],
      ["verifying", "pending"],
    ]);
  });

  it("DESIGN.md §6: shows the happy path so far, awaiting approval", () => {
    // A change already resolved skips `resolving` entirely; its history
    // never gets a COMPLETED event for it, so it stays pending, not done.
    const progress = buildJobProgress(
      job({
        stage: "awaiting_approval",
        history: [
          evt("received", "STARTED"),
          evt("received", "COMPLETED"),
          evt("analyzing", "STARTED"),
          evt("analyzing", "COMPLETED"),
          evt("simulating", "STARTED"),
          evt("simulating", "COMPLETED"),
          evt("validating", "STARTED"),
          evt("validating", "COMPLETED"),
          evt("awaiting_approval", "STARTED"),
        ],
      }),
    );
    expect(progress?.kind).toBe("steps");
    if (progress?.kind !== "steps") throw new Error("expected steps");
    expect(progress.steps.map((step) => step.status)).toEqual([
      "done", // received
      "pending", // resolving — skipped, never done
      "done", // analyzing
      "done", // simulating
      "done", // validating
      "active", // awaiting_approval
      "pending", // applying
      "pending", // verifying
    ]);
  });

  it("marks every stage done once the full pipeline completes", () => {
    const history = [
      evt("received", "STARTED"),
      evt("received", "COMPLETED"),
      evt("resolving", "STARTED"),
      evt("resolving", "COMPLETED"),
      evt("analyzing", "STARTED"),
      evt("analyzing", "COMPLETED"),
      evt("simulating", "STARTED"),
      evt("simulating", "COMPLETED"),
      evt("validating", "STARTED"),
      evt("validating", "COMPLETED"),
      evt("awaiting_approval", "STARTED"),
      evt("awaiting_approval", "COMPLETED"),
      evt("applying", "STARTED"),
      evt("applying", "COMPLETED"),
      evt("verifying", "STARTED"),
      evt("verifying", "COMPLETED"),
      evt("completed", "COMPLETED"),
    ];
    const progress = buildJobProgress(job({ stage: "completed", history }));
    expect(progress?.kind).toBe("steps");
    if (progress?.kind !== "steps") throw new Error("expected steps");
    expect(progress.steps.every((step) => step.status === "done")).toBe(true);
    expect(progress.steps.map((step) => step.stage)).toEqual(ALL_STAGES);
  });

  it("leaves applying and verifying pending after a rejection, though the job is completed", () => {
    // TASK-505: rejection moves awaiting_approval straight to completed. Its
    // own stage still gets a COMPLETED event (a decision was made), but
    // applying/verifying never ran.
    const history = [
      evt("received", "STARTED"),
      evt("received", "COMPLETED"),
      evt("analyzing", "STARTED"),
      evt("analyzing", "COMPLETED"),
      evt("simulating", "STARTED"),
      evt("simulating", "COMPLETED"),
      evt("validating", "STARTED"),
      evt("validating", "COMPLETED"),
      evt("awaiting_approval", "STARTED"),
      evt("awaiting_approval", "COMPLETED"),
      evt("completed", "COMPLETED", "Rejected; nothing will change."),
    ];
    const progress = buildJobProgress(job({ stage: "completed", history }));
    expect(progress?.kind).toBe("steps");
    if (progress?.kind !== "steps") throw new Error("expected steps");
    expect(progress.steps.map((step) => [step.stage, step.status])).toEqual([
      ["received", "done"],
      ["resolving", "pending"],
      ["analyzing", "done"],
      ["simulating", "done"],
      ["validating", "done"],
      ["awaiting_approval", "done"],
      ["applying", "pending"],
      ["verifying", "pending"],
    ]);
    expect(progress.steps.some((step) => step.status === "active")).toBe(false);
  });

  it("shows only the failed stage and its recovery message, not the full list", () => {
    const progress = buildJobProgress(
      job({
        stage: "failed",
        status: "FAILED",
        message: "STALE_VERSION: Production has moved to version 4.",
        history: [
          evt("received", "STARTED"),
          evt("received", "COMPLETED"),
          evt("analyzing", "STARTED"),
          evt("analyzing", "COMPLETED"),
          evt("simulating", "STARTED"),
          evt("simulating", "COMPLETED"),
          evt("validating", "STARTED"),
          evt("validating", "COMPLETED"),
          evt("awaiting_approval", "STARTED"),
          evt("awaiting_approval", "COMPLETED"),
          evt("applying", "STARTED"),
          evt("applying", "FAILED", "STALE_VERSION: Production has moved to version 4."),
        ],
      }),
    );
    expect(progress).toEqual({
      kind: "failed",
      stage: "applying",
      label: "Applying",
      message: "STALE_VERSION: Production has moved to version 4.",
    });
  });
});
