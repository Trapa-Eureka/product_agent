import type { Collection, Document } from "mongodb";

import type { JobRunRepository } from "@pca/application";
import type { JobRun } from "@pca/contracts";
import { jobRunSchema } from "@pca/contracts";

import { parseRow, validated } from "./rows";

/**
 * Job runs in Mongo (TASK-923, AUD-009).
 *
 * With `PCA_STORAGE=mongo` the runs outlive the process: a restart keeps
 * every "where is my change?" answer, and the runs it interrupted are
 * reconciled at startup rather than lost. `update` is the compare-and-set
 * the port describes: read the row, transform it, replace it only if its
 * revision is still the one read, and try again otherwise — two writers
 * both land, in some order, and neither overwrites the other.
 */

type JobRunRow = JobRun & { readonly _id: string; readonly _rev: number };

const UPDATE_ATTEMPTS = 10;

const fromRow = (row: Document): JobRun => parseRow(jobRunSchema, "jobRuns", row);

export const createMongoJobRunRepository = (
  collection: Collection<JobRunRow>,
): JobRunRepository => ({
  async save(run) {
    const row = { ...validated(jobRunSchema, "jobRuns", run.id, run), _id: run.id };
    await collection.updateOne({ _id: run.id }, { $set: row, $inc: { _rev: 1 } }, { upsert: true });
  },

  async findById(jobId) {
    const row = await collection.findOne({ _id: jobId });
    return row === null ? null : fromRow(row);
  },

  async listByProduction(productionId) {
    const rows = await collection.find({ productionId }).sort({ createdAt: -1, _id: -1 }).toArray();
    return rows.map(fromRow);
  },

  async listUnfinished() {
    const rows = await collection
      .find({ stage: { $nin: ["completed", "failed"] } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    return rows.map(fromRow);
  },

  async update(jobId, transform) {
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt += 1) {
      const current = await collection.findOne({ _id: jobId });
      if (current === null) return null;
      const { run: next, result } = transform(fromRow(current));
      const run = validated(jobRunSchema, "jobRuns", jobId, next);
      const replaced = await collection.replaceOne(
        { _id: jobId, _rev: current._rev },
        { ...run, _rev: current._rev + 1 },
      );
      if (replaced.matchedCount === 1) return result;
      // Someone else wrote between our read and our write: read again.
    }
    throw new Error(
      `MONGO_JOB_RUN_CONTENTION: job ${jobId} was rewritten ${UPDATE_ATTEMPTS} times while updating it.`,
    );
  },
});

export type { JobRunRow };
