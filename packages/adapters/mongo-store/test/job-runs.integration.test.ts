import { afterAll, describe, expect, it } from "vitest";

import {
  INTERRUPTED_REASON,
  INTERRUPTED_WHILE_APPLYING_REASON,
  createJobTracker,
  reconcileInterruptedRuns,
} from "@pca/application";
import { describeJobRunContract, fixedClock, sequentialIds } from "@pca/test-support";

import { databaseNameOf, openStore, shutdown } from "./replica-set";

afterAll(shutdown);

describeJobRunContract("mongo job runs", async () => (await openStore()).jobRuns);

/** TASK-923 (AUD-009): runs survive a restart; the interrupted ones are reconciled. */
describe("mongo job runs across a restart", () => {
  const NOW = "2026-09-10T12:00:00.000Z";

  it("keeps every run, fails the interrupted ones with a reason, and keeps those waiting on a human", async () => {
    const first = await openStore();
    const tracker = createJobTracker({
      repository: first.jobRuns,
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });
    const start = () =>
      tracker.start({ productionId: "PROD-DEMO", correlationId: "corr-1", type: "ANALYZE_CHANGE" });
    const analyzing = await start();
    await tracker.advance(analyzing.id, "analyzing");
    const applying = await start();
    for (const stage of [
      "analyzing",
      "simulating",
      "validating",
      "awaiting_approval",
      "applying",
    ] as const) {
      await tracker.advance(applying.id, stage);
    }
    const awaiting = await start();
    for (const stage of ["analyzing", "simulating", "validating", "awaiting_approval"] as const) {
      await tracker.advance(awaiting.id, stage, { proposalId: "P-1" });
    }
    const resolving = await start();
    await tracker.advance(resolving.id, "resolving");
    const done = await start();
    await tracker.fail(done.id, "gave up");
    await first.close();

    // "Restart": a new connection to the same database, a new tracker.
    const second = await openStore(databaseNameOf(first));
    const restarted = createJobTracker({
      repository: second.jobRuns,
      clock: fixedClock("2026-09-10T13:00:00.000Z"),
      ids: sequentialIds(),
    });
    expect((await second.jobRuns.listByProduction("PROD-DEMO")).map((run) => run.id)).toHaveLength(
      5,
    );

    const outcome = await reconcileInterruptedRuns({
      tracker: restarted,
      repository: second.jobRuns,
    });
    expect(outcome.failed.map((run) => run.id).sort()).toEqual([analyzing.id, applying.id].sort());
    expect(outcome.kept.map((run) => run.id).sort()).toEqual([awaiting.id, resolving.id].sort());

    expect(await second.jobRuns.findById(analyzing.id)).toMatchObject({
      stage: "failed",
      message: INTERRUPTED_REASON,
    });
    expect(await second.jobRuns.findById(applying.id)).toMatchObject({
      stage: "failed",
      message: INTERRUPTED_WHILE_APPLYING_REASON,
    });
    expect((await second.jobRuns.findById(awaiting.id))?.stage).toBe("awaiting_approval");
    expect((await second.jobRuns.findById(resolving.id))?.stage).toBe("resolving");
    expect((await second.jobRuns.findById(done.id))?.message).toBe("gave up");
    // A second reconciliation finds nothing left to do.
    const again = await reconcileInterruptedRuns({
      tracker: restarted,
      repository: second.jobRuns,
    });
    expect(again.failed).toEqual([]);
    expect(again.kept.map((run) => run.id).sort()).toEqual([awaiting.id, resolving.id].sort());
  });
});
