import type {
  Conflict,
  EntityId,
  Impact,
  ProductionVersion,
  ProposedOperation,
  SimulationSummary,
} from "@pca/contracts";
import { simulateProposalInputSchema } from "@pca/contracts";
import { indexProduction, simulateProposal } from "@pca/domain";

import type { RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Simulation as a use case (MCP.md §5 `simulate_proposal`).
 *
 * A read that returns a would-be world. The caller states the version it
 * analysed against; if the production has moved on, the answer is an error
 * rather than a simulation of the wrong world, and the next step is to reload.
 */

export type SimulateProposalInput = {
  readonly productionId: EntityId;
  readonly baseProductionVersion: ProductionVersion;
  readonly operations: readonly ProposedOperation[];
  readonly correlationId?: string;
};

export type SimulationReport = {
  readonly valid: boolean;
  readonly impacts: Impact[];
  readonly conflicts: Conflict[];
  readonly resolvedConflicts: Conflict[];
  readonly warnings: string[];
  readonly postStateSummary: SimulationSummary;
};

export type SimulateProposal = (
  input: SimulateProposalInput,
) => Promise<UseCaseResult<SimulationReport>>;

export const createSimulateProposal = (dependencies: {
  readonly repositories: RepositorySet;
}): SimulateProposal => {
  const { repositories } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };

    const parsed = simulateProposalInputSchema.safeParse({
      productionId: input.productionId,
      baseProductionVersion: input.baseProductionVersion,
      operations: input.operations,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        "INVALID_INPUT",
        `The request is malformed: ${issue?.message ?? "unknown issue"}.`,
        {
          ...trace,
          actual: issue?.path.join(".") ?? "<root>",
          nextStep:
            "Provide at least one operation from the allow-list and the base production version.",
        },
      );
    }

    const state = await repositories.productions.loadState(input.productionId);
    if (state === null) {
      return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
        ...trace,
        actual: input.productionId,
        nextStep: "Call get_production with a known production ID.",
      });
    }

    if (state.production.version !== parsed.data.baseProductionVersion) {
      return fail(
        "PRODUCTION_VERSION_MISMATCH",
        `The operations were prepared against version ${parsed.data.baseProductionVersion} but production ${input.productionId} is now at version ${state.production.version}.`,
        {
          ...trace,
          expected: String(parsed.data.baseProductionVersion),
          actual: String(state.production.version),
          nextStep: "Reload production state and re-run analysis before simulating.",
        },
      );
    }

    const outcome = simulateProposal(indexProduction(state), parsed.data.operations);
    return succeed({
      valid: outcome.valid,
      impacts: outcome.impacts,
      conflicts: outcome.conflicts,
      resolvedConflicts: outcome.resolvedConflicts,
      warnings: outcome.warnings,
      postStateSummary: outcome.summary,
    });
  };
};
