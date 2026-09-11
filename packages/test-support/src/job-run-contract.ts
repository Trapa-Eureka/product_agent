import { describe, expect, it } from "vitest";

import type { JobRunRepository } from "@pca/application";
import { createJobTracker } from "@pca/application";

import { fixedClock, sequentialIds } from "./determinism";

/**
 * The job-run repository contract (TASK-923): what every adapter — memory
 * or Mongo — must do the same way, so the tracker's atomic moves mean the
 * same thing wherever runs live.
 */
export const describeJobRunContract = (
  name: string,
  factory: () => Promise<JobRunRepository> | JobRunRepository,
): void => {
  describe(`job run repository contract: ${name}`, () => {
    const NOW = "2026-09-10T12:00:00.000Z";
    const trackerOver = (repository: JobRunRepository) =>
      createJobTracker({ repository, clock: fixedClock(NOW), ids: sequentialIds() });
    const start = (tracker: ReturnType<typeof trackerOver>, productionId = "PROD-DEMO") =>
      tracker.start({
        productionId,
        correlationId: "corr-1",
        type: "ANALYZE_CHANGE",
        requestedBy: "jinho@example.test",
      });

    it("round-trips a run and hands out copies", async () => {
      const repository = await factory();
      const run = await start(trackerOver(repository));
      const found = await repository.findById(run.id);
      expect(found).toEqual(run);
      expect(await repository.findById("JOB-404")).toBeNull();
      (found as { stage: string }).stage = "failed";
      expect((await repository.findById(run.id))?.stage).toBe("received");
    });

    it("lists a production's runs newest first, and nothing from another production", async () => {
      const repository = await factory();
      const tracker = createJobTracker({
        repository,
        clock: {
          now: (() => {
            let tick = 0;
            return () => `2026-09-10T12:00:0${(tick += 1)}.000Z`;
          })(),
        },
        ids: sequentialIds(),
      });
      const first = await tracker.start({
        productionId: "PROD-DEMO",
        correlationId: "c",
        type: "ANALYZE_CHANGE",
      });
      const second = await tracker.start({
        productionId: "PROD-DEMO",
        correlationId: "c",
        type: "ANALYZE_CHANGE",
      });
      await tracker.start({
        productionId: "PROD-OTHER",
        correlationId: "c",
        type: "ANALYZE_CHANGE",
      });
      expect((await repository.listByProduction("PROD-DEMO")).map((run) => run.id)).toEqual([
        second.id,
        first.id,
      ]);
    });

    it("updates atomically: the transform's result comes back, a throw writes nothing, unknown is null", async () => {
      const repository = await factory();
      const run = await start(trackerOver(repository));
      const result = await repository.update(run.id, (current) => ({
        run: { ...current, message: "noted" },
        result: current.stage,
      }));
      expect(result).toBe("received");
      expect((await repository.findById(run.id))?.message).toBe("noted");
      await expect(
        repository.update(run.id, () => {
          throw new Error("refused");
        }),
      ).rejects.toThrow("refused");
      expect((await repository.findById(run.id))?.message).toBe("noted");
      expect(
        await repository.update("JOB-404", (current) => ({ run: current, result: 1 })),
      ).toBeNull();
    });

    it("lets two concurrent updates both land", async () => {
      const repository = await factory();
      const run = await start(trackerOver(repository));
      const append = (label: string) =>
        repository.update(run.id, (current) => ({
          run: { ...current, message: `${current.message ?? ""}${label}` },
          result: label,
        }));
      await Promise.all([append("a"), append("b"), append("c")]);
      const message = (await repository.findById(run.id))?.message ?? "";
      expect([...message].sort()).toEqual(["a", "b", "c"]);
    });

    it("lists unfinished runs across productions, oldest first, never a finished one", async () => {
      const repository = await factory();
      const tracker = trackerOver(repository);
      const demo = await start(tracker, "PROD-DEMO");
      const other = await start(tracker, "PROD-OTHER");
      const done = await start(tracker, "PROD-DEMO");
      await tracker.fail(done.id, "gave up");
      expect((await repository.listUnfinished()).map((run) => run.id)).toEqual([demo.id, other.id]);
    });
  });
};
