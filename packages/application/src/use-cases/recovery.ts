import type { EntityId, JobRun, Proposal, RecoverySnapshot } from "@pca/contracts";
import { OPEN_PROPOSAL_STATUSES } from "@pca/contracts";

import type { Clock, JobRunReader, RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Recovery queries (TASK-405, ARCHITECTURE.md §11).
 *
 * The socket is a notification channel; these reads are the truth a client
 * returns to after losing it. A snapshot is everything a production view
 * needs to be correct again: the version, every job run, and every proposal
 * still open. Live notifications then apply on top of it.
 */

export type GetRecoverySnapshot = (input: {
  readonly productionId: EntityId;
  readonly correlationId?: string;
}) => Promise<UseCaseResult<RecoverySnapshot>>;

export type GetJobRun = (input: {
  readonly productionId: EntityId;
  readonly jobId: EntityId;
  readonly correlationId?: string;
}) => Promise<UseCaseResult<JobRun>>;

export const createGetRecoverySnapshot = (dependencies: {
  readonly repositories: RepositorySet;
  readonly jobRuns: JobRunReader;
  readonly clock: Clock;
}): GetRecoverySnapshot => {
  const { repositories, jobRuns, clock } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };
    const state = await repositories.productions.loadState(input.productionId);
    if (state === null) {
      return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
        ...trace,
        actual: input.productionId,
        nextStep: "Call get_production with a known production ID.",
      });
    }
    const openProposals: Proposal[] = [];
    for (const status of OPEN_PROPOSAL_STATUSES) {
      openProposals.push(
        ...(await repositories.proposals.listByStatus(input.productionId, status)),
      );
    }
    openProposals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return succeed({
      productionId: input.productionId,
      productionVersion: state.production.version,
      asOf: clock.now(),
      jobs: await jobRuns.listByProduction(input.productionId),
      openProposals,
    });
  };
};

/** A job is visible only through its own production; a mismatch reads as not found. */
export const createGetJobRun = (dependencies: { readonly jobRuns: JobRunReader }): GetJobRun => {
  const { jobRuns } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };
    const run = await jobRuns.findById(input.jobId);
    if (run === null || run.productionId !== input.productionId) {
      return fail(
        "ENTITY_NOT_FOUND",
        `Job ${input.jobId} does not exist in production ${input.productionId}.`,
        {
          ...trace,
          actual: input.jobId,
          nextStep: "List the production's jobs through the recovery snapshot.",
        },
      );
    }
    return succeed(run);
  };
};
