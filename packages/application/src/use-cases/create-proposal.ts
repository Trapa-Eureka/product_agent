import type {
  ActorType,
  AuditEvent,
  EntityId,
  ProductionVersion,
  Proposal,
  ProposedOperation,
} from "@pca/contracts";
import { createProposalInputSchema } from "@pca/contracts";
import { computeProposalDigest, indexProduction, simulateProposal } from "@pca/domain";

import type { Clock, IdFactory, RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Proposal creation (MCP.md §6 `create_proposal`).
 *
 * Seals a set of operations into a proposal: simulates them against the
 * current production, records the verdict, and computes the digest an
 * approval will bind to (INV-6). An invalid proposal is still persisted, as a
 * DRAFT, so the coordinator can see exactly why it cannot be approved; it just
 * never becomes approvable.
 *
 * Not a business-state mutation, but auditable: the audit trail shows who
 * proposed what and when, which is the "Agent proposed P-104" line.
 */

export type CreateProposalInput = {
  readonly productionId: EntityId;
  readonly changeRequestId: EntityId;
  readonly baseProductionVersion: ProductionVersion;
  readonly operations: readonly ProposedOperation[];
  readonly summary: string;
  readonly proposedBy: string;
  readonly actorType?: ActorType;
  readonly correlationId?: string;
};

export type CreateProposal = (input: CreateProposalInput) => Promise<UseCaseResult<Proposal>>;

export const createCreateProposal = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): CreateProposal => {
  const { repositories, clock, ids } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };

    const parsed = createProposalInputSchema.safeParse({
      productionId: input.productionId,
      changeRequestId: input.changeRequestId,
      baseProductionVersion: input.baseProductionVersion,
      operations: input.operations,
      summary: input.summary,
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
            "Provide at least one allow-listed operation, a summary, and the base production version.",
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
        `The operations were simulated against version ${parsed.data.baseProductionVersion} but production ${input.productionId} is now at version ${state.production.version}.`,
        {
          ...trace,
          expected: String(parsed.data.baseProductionVersion),
          actual: String(state.production.version),
          nextStep: "Reload production state and re-run simulation before proposing.",
        },
      );
    }

    const changeRequest = await repositories.changeRequests.findById(
      input.productionId,
      parsed.data.changeRequestId,
    );
    if (changeRequest === null) {
      return fail(
        "ENTITY_NOT_FOUND",
        `Change request ${parsed.data.changeRequestId} does not exist in production ${input.productionId}.`,
        { ...trace, actual: parsed.data.changeRequestId, nextStep: "Submit the change first." },
      );
    }

    const outcome = simulateProposal(indexProduction(state), parsed.data.operations);
    const createdAt = clock.now();
    const proposalId = ids.next("P");

    const proposal: Proposal = {
      id: proposalId,
      productionId: input.productionId,
      changeRequestId: changeRequest.id,
      baseProductionVersion: state.production.version,
      operations: parsed.data.operations,
      impacts: outcome.impacts,
      conflicts: outcome.conflicts,
      warnings: outcome.warnings,
      validationStatus: outcome.valid ? "VALID" : "INVALID",
      status: outcome.valid ? "AWAITING_APPROVAL" : "DRAFT",
      digest: computeProposalDigest({
        productionId: input.productionId,
        changeRequestId: changeRequest.id,
        baseProductionVersion: state.production.version,
        operations: parsed.data.operations,
      }),
      summary: parsed.data.summary,
      createdAt,
    };

    const audit: AuditEvent = {
      id: ids.next("AE"),
      productionId: input.productionId,
      actorType: input.actorType ?? "AGENT",
      actorId: input.proposedBy,
      action: "PROPOSAL_CREATED",
      entityType: "PROPOSAL",
      entityId: proposal.id,
      correlationId: input.correlationId ?? changeRequest.correlationId,
      metadata: {
        changeRequestId: changeRequest.id,
        operationCount: proposal.operations.length,
        validationStatus: proposal.validationStatus,
        conflictCount: proposal.conflicts.length,
        digest: proposal.digest,
      },
      createdAt,
    };

    await repositories.proposals.save(proposal);
    await repositories.auditEvents.append(audit);

    return succeed(proposal);
  };
};
