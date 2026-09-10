import type { Clock, IdFactory, RepositorySet } from "@pca/application";
import { createCreateProposal, fail, succeed } from "@pca/application";

import type { ToolHandlers } from "../server";

/**
 * Proposal tools (MCP.md §6).
 *
 * create_proposal records the server's acting identity as the proposer. The
 * agent does not say who it is; the context does, which is what makes the
 * "Agent proposed P-104" audit line trustworthy.
 *
 * get_proposal is a plain read of the stored record. Its validity is whatever
 * the last create, validate, or apply wrote, which is why validate_proposal
 * persists its verdict.
 */
export const createProposalToolHandlers = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): ToolHandlers => {
  const { repositories } = dependencies;
  const create = createCreateProposal(dependencies);

  return {
    create_proposal: async (input, call) => {
      const result = await create({
        ...input,
        proposedBy: call.actor.id,
        actorType: call.actor.type,
        correlationId: call.correlationId,
      });
      return result.ok ? succeed({ proposal: result.value }) : result;
    },

    get_proposal: async (input, call) => {
      const proposal = await repositories.proposals.findById(input.productionId, input.proposalId);
      if (proposal === null) {
        return fail(
          "ENTITY_NOT_FOUND",
          `Proposal ${input.proposalId} does not exist in production ${input.productionId}.`,
          {
            correlationId: call.correlationId,
            actual: input.proposalId,
            nextStep: "Create a proposal with create_proposal, or check the ID.",
          },
        );
      }
      return succeed({ proposal });
    },
  };
};
