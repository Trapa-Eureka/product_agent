import { beforeEach, describe, expect, it } from "vitest";

import type { Proposal } from "@pca/contracts";
import { recoverySnapshotSchema } from "@pca/contracts";
import { DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, sequentialIds } from "@pca/test-support";

import {
  createGetJobRun,
  createGetRecoverySnapshot,
  createJobTracker,
  type GetJobRun,
  type GetRecoverySnapshot,
  type JobRunRepository,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const NOW = "2026-09-10T12:00:00.000Z";

const proposal = (id: string, status: Proposal["status"], createdAt: string): Proposal => ({
  id,
  productionId: DEMO,
  changeRequestId: "CR-1",
  baseProductionVersion: 1,
  operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: DEMO_MOVIE_IDS.callSheets.friday }],
  impacts: [],
  conflicts: [],
  warnings: [],
  validationStatus: "VALID",
  status,
  digest: "a".repeat(64),
  summary: `Proposal ${id}`,
  createdAt,
});

describe("recovery queries", () => {
  let store: MemoryStore;
  let jobRuns: JobRunRepository;
  let snapshot: GetRecoverySnapshot;
  let jobRun: GetJobRun;

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    jobRuns = createMemoryJobRunRepository();
    snapshot = createGetRecoverySnapshot({ repositories: store, jobRuns, clock: fixedClock(NOW) });
    jobRun = createGetJobRun({ jobRuns });
  });

  it("returns the version, every job run newest first, and only the open proposals, newest first", async () => {
    const clock = fixedClock(NOW);
    const tracker = createJobTracker({ repository: jobRuns, clock, ids: sequentialIds() });
    await tracker.start({ productionId: DEMO, correlationId: "corr-1", type: "ANALYZE_CHANGE" });
    clock.advance(1000);
    await tracker.start({ productionId: DEMO, correlationId: "corr-2", type: "ANALYZE_CHANGE" });
    await tracker.start({
      productionId: "PROD-OTHER",
      correlationId: "corr-3",
      type: "ANALYZE_CHANGE",
    });
    await store.proposals.save(proposal("P-1", "AWAITING_APPROVAL", "2026-09-10T11:00:00.000Z"));
    await store.proposals.save(proposal("P-2", "REJECTED", "2026-09-10T11:01:00.000Z"));
    await store.proposals.save(proposal("P-3", "APPROVED", "2026-09-10T11:02:00.000Z"));
    await store.proposals.save(proposal("P-4", "DRAFT", "2026-09-10T11:03:00.000Z"));
    await store.proposals.save(proposal("P-5", "APPLIED", "2026-09-10T11:04:00.000Z"));

    const result = await snapshot({ productionId: DEMO });
    if (!result.ok) throw new Error(result.error.message);
    expect(recoverySnapshotSchema.parse(result.value)).toEqual(result.value);
    expect(result.value).toMatchObject({ productionId: DEMO, productionVersion: 1, asOf: NOW });
    expect(result.value.jobs.map((run) => run.id)).toEqual(["JOB-2", "JOB-1"]);
    expect(result.value.openProposals.map((entry) => entry.id)).toEqual(["P-4", "P-3", "P-1"]);
  });

  it("refuses an unknown production", async () => {
    const result = await snapshot({ productionId: "PROD-NOPE" });
    expect(!result.ok && result.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it("reads one job only through its own production", async () => {
    const tracker = createJobTracker({
      repository: jobRuns,
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });
    await tracker.start({ productionId: DEMO, correlationId: "corr-1", type: "ANALYZE_CHANGE" });
    const found = await jobRun({ productionId: DEMO, jobId: "JOB-1" });
    expect(found.ok && found.value.stage).toBe("received");
    const foreign = await jobRun({ productionId: "PROD-OTHER", jobId: "JOB-1" });
    expect(!foreign.ok && foreign.error.code).toBe("ENTITY_NOT_FOUND");
    const missing = await jobRun({ productionId: DEMO, jobId: "JOB-9" });
    expect(!missing.ok && missing.error.code).toBe("ENTITY_NOT_FOUND");
  });
});
