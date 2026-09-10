import type { Conflict, EntityId, Impact, ProductionVersion, TypedChange } from "@pca/contracts";
import { typedChangeSchema } from "@pca/contracts";
import { analyzeImpact, indexProduction } from "@pca/domain";

import type { RepositorySet } from "../ports";
import { firstMissingReference } from "../references";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Impact analysis as a use case (MCP.md §5 `analyze_change_impact`).
 *
 * A read. It loads the current snapshot, confirms the change's references,
 * and hands the deterministic engine the rest. The production version is
 * returned alongside so a later proposal can prove it was built against the
 * same world the analysis described.
 */

export type AnalyzeChangeImpactInput = {
  readonly productionId: EntityId;
  readonly change: TypedChange;
  readonly correlationId?: string;
};

export type ChangeImpactReport = {
  readonly productionVersion: ProductionVersion;
  readonly impacts: Impact[];
  readonly conflicts: Conflict[];
  readonly affectedEntityIds: EntityId[];
};

export type AnalyzeChangeImpact = (
  input: AnalyzeChangeImpactInput,
) => Promise<UseCaseResult<ChangeImpactReport>>;

export const createAnalyzeChangeImpact = (dependencies: {
  readonly repositories: RepositorySet;
}): AnalyzeChangeImpact => {
  const { repositories } = dependencies;

  return async (input) => {
    const parsed = typedChangeSchema.safeParse(input.change);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        "INVALID_INPUT",
        `The typed change is malformed: ${issue?.message ?? "unknown issue"}.`,
        {
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          actual: issue?.path.join(".") ?? "<root>",
          nextStep: "Submit a change that matches the TypedChange schema.",
        },
      );
    }

    const state = await repositories.productions.loadState(input.productionId);
    if (state === null) {
      return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        actual: input.productionId,
        nextStep: "Call get_production with a known production ID.",
      });
    }

    const index = indexProduction(state);
    const missing = firstMissingReference(index, parsed.data);
    if (missing !== null) {
      return fail(
        "ENTITY_NOT_FOUND",
        `No ${missing.kind} ${missing.id} exists in production ${input.productionId}.`,
        {
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          actual: missing.id,
          nextStep: `Resolve the ${missing.kind} with ${missing.lookupTool} and submit the ID it returns.`,
        },
      );
    }

    const analysis = analyzeImpact(index, parsed.data);
    return succeed({ productionVersion: state.production.version, ...analysis });
  };
};
