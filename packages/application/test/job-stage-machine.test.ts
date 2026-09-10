import { describe, expect, it } from "vitest";

import type { JobStage } from "@pca/contracts";
import { jobRunSchema, jobStageSchema } from "@pca/contracts";

import {
  JOB_STAGE_TRANSITIONS,
  JobStageError,
  advanceJobRun,
  canAdvance,
  failJobRun,
  isTerminalStage,
  noteJobRun,
  startJobRun,
} from "../src";

const NOW = "2026-09-10T12:00:00.000Z";
const LATER = "2026-09-10T12:00:01.000Z";

const fresh = () =>
  startJobRun({
    id: "JOB-1",
    productionId: "PROD-DEMO",
    correlationId: "corr-1",
    type: "ANALYZE_CHANGE",
    now: NOW,
  }).run;

/** Walks a run along a path of stages. */
const walk = (stages: Exclude<JobStage, "failed">[]) =>
  stages.reduce((run, stage) => advanceJobRun(run, stage, LATER).run, fresh());

describe("job stage graph", () => {
  it("names every stage the contract knows, and only those", () => {
    expect(Object.keys(JOB_STAGE_TRANSITIONS).sort()).toEqual([...jobStageSchema.options].sort());
  });

  it("reaches applying only from awaiting_approval", () => {
    const sources = jobStageSchema.options.filter((stage) => canAdvance(stage, "applying"));
    expect(sources).toEqual(["awaiting_approval"]);
  });

  it("has no way out of a terminal stage", () => {
    expect(JOB_STAGE_TRANSITIONS.completed).toEqual([]);
    expect(JOB_STAGE_TRANSITIONS.failed).toEqual([]);
    expect(isTerminalStage("completed")).toBe(true);
    expect(isTerminalStage("awaiting_approval")).toBe(false);
  });

  it("can fail from every non-terminal stage", () => {
    for (const stage of jobStageSchema.options) {
      expect(canAdvance(stage, "failed")).toBe(!isTerminalStage(stage));
    }
  });

  it("follows the full happy path in order", () => {
    const run = walk([
      "resolving",
      "analyzing",
      "simulating",
      "validating",
      "awaiting_approval",
      "applying",
      "verifying",
      "completed",
    ]);
    expect(run.stage).toBe("completed");
    expect(run.status).toBe("COMPLETED");
    expect(run.history.map((event) => `${event.stage}:${event.status}`)).toEqual([
      "received:STARTED",
      "received:COMPLETED",
      "resolving:STARTED",
      "resolving:COMPLETED",
      "analyzing:STARTED",
      "analyzing:COMPLETED",
      "simulating:STARTED",
      "simulating:COMPLETED",
      "validating:STARTED",
      "validating:COMPLETED",
      "awaiting_approval:STARTED",
      "awaiting_approval:COMPLETED",
      "applying:STARTED",
      "applying:COMPLETED",
      "verifying:STARTED",
      "verifying:COMPLETED",
      "completed:COMPLETED",
    ]);
    expect(jobRunSchema.parse(run)).toEqual(run);
  });

  it("lets a pre-resolved change skip resolving, and lets analysis complete with nothing to do", () => {
    expect(walk(["analyzing", "completed"]).stage).toBe("completed");
  });

  it("lets a rejection complete the run from awaiting_approval", () => {
    const run = walk(["resolving", "analyzing", "simulating", "validating", "awaiting_approval"]);
    expect(advanceJobRun(run, "completed", LATER, { message: "Rejected" }).run).toMatchObject({
      stage: "completed",
      message: "Rejected",
    });
  });
});

describe("disallowed moves", () => {
  it("refuses to skip approval, naming the allowed moves", () => {
    const run = walk(["resolving", "analyzing", "simulating", "validating"]);
    expect(() => advanceJobRun(run, "applying", LATER)).toThrow(JobStageError);
    expect(() => advanceJobRun(run, "applying", LATER)).toThrow(
      "Job JOB-1 cannot move from validating to applying. Allowed: awaiting_approval, failed.",
    );
  });

  it("refuses to move backwards", () => {
    const run = walk(["resolving", "analyzing"]);
    expect(() => advanceJobRun(run, "resolving", LATER)).toThrow(JobStageError);
  });

  it("refuses to leave a terminal stage, even to fail or note", () => {
    const done = walk(["analyzing", "completed"]);
    expect(() => advanceJobRun(done, "analyzing", LATER)).toThrow(/terminal stage/);
    expect(() => failJobRun(done, "late", LATER)).toThrow(JobStageError);
    expect(() => noteJobRun(done, "late", LATER)).toThrow(JobStageError);
    const dead = failJobRun(fresh(), "boom", LATER).run;
    expect(() => advanceJobRun(dead, "resolving", LATER)).toThrow(JobStageError);
  });

  it("carries the job, from, and to on the error", () => {
    try {
      advanceJobRun(fresh(), "verifying", LATER);
      throw new Error("expected a JobStageError");
    } catch (error) {
      expect(error).toBeInstanceOf(JobStageError);
      expect(error).toMatchObject({
        code: "INVALID_STAGE_TRANSITION",
        jobId: "JOB-1",
        from: "received",
        to: "verifying",
      });
    }
  });
});

describe("events", () => {
  it("starting publishes received STARTED and records it", () => {
    const { run, events } = startJobRun({
      id: "JOB-1",
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "APPLY_PROPOSAL",
      now: NOW,
      proposalId: "P-1",
    });
    expect(events).toEqual([
      {
        jobId: "JOB-1",
        productionId: "PROD-DEMO",
        correlationId: "corr-1",
        stage: "received",
        status: "STARTED",
        occurredAt: NOW,
      },
    ]);
    expect(run).toMatchObject({ stage: "received", status: "STARTED", proposalId: "P-1" });
    expect(run.history).toEqual(events);
  });

  it("advancing publishes the stage left as COMPLETED and the stage entered as STARTED, with the message on the entry", () => {
    const { run, events } = advanceJobRun(fresh(), "resolving", LATER, { message: "Reading" });
    expect(events.map((event) => [event.stage, event.status, event.message])).toEqual([
      ["received", "COMPLETED", undefined],
      ["resolving", "STARTED", "Reading"],
    ]);
    expect(run).toMatchObject({ stage: "resolving", status: "STARTED", message: "Reading" });
    expect(run.updatedAt).toBe(LATER);
    expect(run.createdAt).toBe(NOW);
  });

  it("failing publishes FAILED against the stage that was running", () => {
    const running = walk([
      "resolving",
      "analyzing",
      "simulating",
      "validating",
      "awaiting_approval",
      "applying",
    ]);
    const { run, events } = failJobRun(running, "STALE_PRODUCTION_VERSION: moved on", LATER);
    expect(events).toEqual([
      expect.objectContaining({
        stage: "applying",
        status: "FAILED",
        message: "STALE_PRODUCTION_VERSION: moved on",
      }),
    ]);
    expect(run).toMatchObject({
      stage: "failed",
      status: "FAILED",
      message: "STALE_PRODUCTION_VERSION: moved on",
    });
  });

  it("noting re-announces the current stage without moving", () => {
    const waiting = walk(["resolving"]);
    const { run, events } = noteJobRun(waiting, "Which Sarah?", LATER);
    expect(events).toEqual([
      expect.objectContaining({ stage: "resolving", status: "STARTED", message: "Which Sarah?" }),
    ]);
    expect(run.stage).toBe("resolving");
    expect(run.history).toHaveLength(waiting.history.length + 1);
    expect(run.options).toBeUndefined();
  });

  it("noting with options carries them on the run but not on the event (TASK-502)", () => {
    const waiting = walk(["resolving"]);
    const friday = { start: "2026-09-18", end: "2026-09-18" };
    const options = [
      {
        label: "Sarah",
        change: { type: "CAST_UNAVAILABLE", castId: "CAST-SARAH", unavailable: friday },
      },
      {
        label: "Sarah",
        change: { type: "CAST_UNAVAILABLE", castId: "CAST-SARAH-2", unavailable: friday },
      },
    ] as const;
    const { run, events } = noteJobRun(waiting, "Which one?", LATER, options);
    expect(run.options).toEqual(options);
    expect(events[0]).not.toHaveProperty("options");
    // A second note, without options, does not erase the ones already recorded.
    const followUp = noteJobRun(run, "Still waiting.", LATER);
    expect(followUp.run.options).toEqual(options);
  });

  it("never mutates the run it is given", () => {
    const before = fresh();
    const snapshot = structuredClone(before);
    advanceJobRun(before, "resolving", LATER);
    failJobRun(before, "x", LATER);
    noteJobRun(before, "y", LATER);
    expect(before).toEqual(snapshot);
  });
});
