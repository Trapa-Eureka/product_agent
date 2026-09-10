import type { Conflict, EntityId, ProductionVersion, Proposal } from "@pca/contracts";
import { computeProposalDigest, indexProduction, simulateProposal } from "@pca/domain";

import type { RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Proposal validation (MCP.md §5 `validate_proposal`, SPEC.md FR-6).
 *
 * Re-judges a stored proposal against the production as it is now. Three
 * things can have changed since the proposal was made: the world (stale
 * version), the proposal itself (digest no longer matches), or nothing. Only
 * the last leaves it applicable.
 *
 * The refreshed verdict is written back onto the proposal so `get_proposal`
 * never reports a validity the world has since contradicted. That is a change
 * to proposal metadata, not to production state; no business entity moves.
 */

export type ValidateProposalInput = {
  readonly productionId: EntityId;
  readonly proposalId: EntityId;
  readonly correlationId?: string;
};

export type ProposalValidation = {
  readonly valid: boolean;
  readonly productionVersion: ProductionVersion;
  readonly baseProductionVersion: ProductionVersion;
  readonly warnings: string[];
  readonly conflicts: Conflict[];
  readonly proposal: Proposal;
};

export type ValidateProposal = (
  input: ValidateProposalInput,
) => Promise<UseCaseResult<ProposalValidation>>;

const staleConflict = (proposal: Proposal, current: ProductionVersion): Conflict => ({
  code: "STALE_PRODUCTION_VERSION",
  entityType: "PRODUCTION",
  entityId: proposal.productionId,
  detail: `Proposal ${proposal.id} was simulated against version ${proposal.baseProductionVersion} but the production is now at version ${current}. Re-run simulation.`,
});

export const createValidateProposal = (dependencies: {
  readonly repositories: RepositorySet;
}): ValidateProposal => {
  const { repositories } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };

    const proposal = await repositories.proposals.findById(input.productionId, input.proposalId);
    if (proposal === null) {
      return fail(
        "ENTITY_NOT_FOUND",
        `Proposal ${input.proposalId} does not exist in production ${input.productionId}.`,
        {
          ...trace,
          actual: input.proposalId,
          nextStep: "Create a proposal with create_proposal first.",
        },
      );
    }

    const recomputed = computeProposalDigest(proposal);
    if (recomputed !== proposal.digest) {
      return fail(
        "PROPOSAL_INVALID",
        `Proposal ${proposal.id} no longer hashes to its stored digest, so its operations changed after it was created.`,
        {
          ...trace,
          expected: proposal.digest,
          actual: recomputed,
          nextStep: "Discard this proposal and create a new one from a fresh simulation.",
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

    const current = state.production.version;
    const outcome = simulateProposal(indexProduction(state), proposal.operations);
    const conflicts =
      current === proposal.baseProductionVersion
        ? outcome.conflicts
        : [staleConflict(proposal, current), ...outcome.conflicts];
    const valid = conflicts.length === 0;

    const refreshed: Proposal = {
      ...proposal,
      validationStatus: valid ? "VALID" : "INVALID",
      conflicts,
      warnings: outcome.warnings,
    };
    if (
      refreshed.validationStatus !== proposal.validationStatus ||
      JSON.stringify(refreshed.conflicts) !== JSON.stringify(proposal.conflicts) ||
      JSON.stringify(refreshed.warnings) !== JSON.stringify(proposal.warnings)
    ) {
      await repositories.proposals.save(refreshed);
    }

    return succeed({
      valid,
      productionVersion: current,
      baseProductionVersion: proposal.baseProductionVersion,
      warnings: outcome.warnings,
      conflicts,
      proposal: refreshed,
    });
  };
};
