import type {
  EntityId,
  LocalDate,
  ProductionVersion,
  RejectedScheduleDay,
  ScheduleCandidate,
} from "@pca/contracts";
import { generateScheduleCandidatesInputSchema } from "@pca/contracts";
import { generateScheduleCandidates, indexProduction } from "@pca/domain";

import type { RepositorySet } from "../ports";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Candidate generation as a use case (MCP.md §5 `generate_schedule_candidates`).
 *
 * A read. It confirms the scenes exist, then hands the deterministic
 * generator the rest. The production version comes back alongside so a
 * proposal built from these candidates can prove it saw the same world.
 */

export type GenerateScheduleCandidatesInput = {
  readonly productionId: EntityId;
  readonly sceneIds: readonly EntityId[];
  readonly excludeDates?: readonly LocalDate[];
  readonly correlationId?: string;
};

export type ScheduleCandidateReport = {
  readonly productionVersion: ProductionVersion;
  readonly candidates: ScheduleCandidate[];
  readonly rejected: RejectedScheduleDay[];
};

export type GenerateScheduleCandidates = (
  input: GenerateScheduleCandidatesInput,
) => Promise<UseCaseResult<ScheduleCandidateReport>>;

export const createGenerateScheduleCandidates = (dependencies: {
  readonly repositories: RepositorySet;
}): GenerateScheduleCandidates => {
  const { repositories } = dependencies;

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };

    const parsed = generateScheduleCandidatesInputSchema.safeParse({
      productionId: input.productionId,
      sceneIds: input.sceneIds,
      ...(input.excludeDates === undefined ? {} : { excludeDates: input.excludeDates }),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        "INVALID_INPUT",
        `The request is malformed: ${issue?.message ?? "unknown issue"}.`,
        {
          ...trace,
          actual: issue?.path.join(".") ?? "<root>",
          nextStep: "Provide at least one scene ID and, if used, exclude dates as YYYY-MM-DD.",
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

    const index = indexProduction(state);
    const unknown = parsed.data.sceneIds.find((sceneId) => !index.sceneById.has(sceneId));
    if (unknown !== undefined) {
      return fail(
        "ENTITY_NOT_FOUND",
        `No scene ${unknown} exists in production ${input.productionId}.`,
        {
          ...trace,
          actual: unknown,
          nextStep: "Resolve the scene with get_scene and submit the ID it returns.",
        },
      );
    }

    const generation = generateScheduleCandidates(index, {
      sceneIds: parsed.data.sceneIds,
      ...(parsed.data.excludeDates === undefined ? {} : { excludeDates: parsed.data.excludeDates }),
    });

    return succeed({ productionVersion: state.production.version, ...generation });
  };
};
