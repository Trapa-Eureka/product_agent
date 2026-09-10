import type { RepositorySet } from "@pca/application";
import {
  createAnalyzeChangeImpact,
  createGenerateScheduleCandidates,
  createSimulateProposal,
  createValidateProposal,
  succeed,
} from "@pca/application";

import type { ToolHandlers } from "../server";

/**
 * Analysis tools (MCP.md §5).
 *
 * Each is a thin adapter over an application use case: pass the correlation
 * ID through, and shape the answer to the output contract. No logic lives
 * here. Notably, validate_proposal's use case also returns the refreshed
 * proposal; the tool does not, because the contract says so and the strict
 * output schema would refuse the extra field.
 */
export const createAnalysisToolHandlers = (dependencies: {
  readonly repositories: RepositorySet;
}): ToolHandlers => {
  const { repositories } = dependencies;
  const analyze = createAnalyzeChangeImpact({ repositories });
  const generate = createGenerateScheduleCandidates({ repositories });
  const simulate = createSimulateProposal({ repositories });
  const validate = createValidateProposal({ repositories });

  return {
    analyze_change_impact: (input, call) =>
      analyze({ ...input, correlationId: call.correlationId }),

    generate_schedule_candidates: (input, call) =>
      generate({
        productionId: input.productionId,
        sceneIds: input.sceneIds,
        ...(input.excludeDates === undefined ? {} : { excludeDates: input.excludeDates }),
        correlationId: call.correlationId,
      }),

    simulate_proposal: (input, call) => simulate({ ...input, correlationId: call.correlationId }),

    validate_proposal: async (input, call) => {
      const result = await validate({ ...input, correlationId: call.correlationId });
      if (!result.ok) return result;
      const { valid, productionVersion, baseProductionVersion, warnings, conflicts } = result.value;
      return succeed({ valid, productionVersion, baseProductionVersion, warnings, conflicts });
    },
  };
};
