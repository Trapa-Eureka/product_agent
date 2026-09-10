import type {
  EntityId,
  InterpretationContext,
  InterpretationOption,
  LocalDate,
  TypedChange,
} from "@pca/contracts";
import type { ProductionState } from "@pca/domain";
import { indexProduction } from "@pca/domain";

import type { Clock, ModelPort, RepositorySet } from "../ports";
import { ModelError, guardModelPort } from "../ports";
import { firstMissingReference } from "../references";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Change interpretation (SPEC.md FR-1, TASK-304).
 *
 * Natural language goes in; a typed change, a question, or a refusal comes
 * out. The model sees only what this use case shows it: the production's
 * names, its shoot days, and today's date in its timezone. Its answer is
 * schema-validated and grounded by the guard, then every ID is checked
 * against the production once more. Nothing here persists; intake does that
 * once the coordinator has confirmed what was detected (DESIGN.md §3).
 */

export type InterpretChangeUseCaseInput = {
  readonly productionId: EntityId;
  readonly text: string;
  readonly correlationId?: string;
};

export type Interpretation =
  | {
      readonly kind: "RESOLVED";
      readonly change: TypedChange;
      readonly confidence: number;
      readonly rationale?: string;
    }
  | {
      readonly kind: "AMBIGUOUS";
      readonly question: string;
      readonly options: InterpretationOption[];
    };

export type InterpretChange = (
  input: InterpretChangeUseCaseInput,
) => Promise<UseCaseResult<Interpretation>>;

/** Today's calendar date in the production's timezone, from an instant. */
export const localDateIn = (timezone: string, instant: string): LocalDate => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/** What a model is allowed to know. Names and dates, never availability, tasks, or history. */
export const interpretationContextFor = (
  state: ProductionState,
  today: LocalDate,
): InterpretationContext => ({
  castMembers: state.castMembers.map((cast) => ({
    id: cast.id,
    name: cast.name,
    ...(cast.roleName === undefined ? {} : { roleName: cast.roleName }),
  })),
  locations: state.locations.map((location) => ({ id: location.id, name: location.name })),
  scenes: state.scenes.map((scene) => ({
    id: scene.id,
    sceneNumber: scene.sceneNumber,
    ...(scene.title === undefined ? {} : { title: scene.title }),
  })),
  shootDays: state.shootDays.map((day) => ({ id: day.id, date: day.date })),
  today,
});

export const createInterpretChange = (dependencies: {
  readonly repositories: RepositorySet;
  readonly model: ModelPort;
  readonly clock: Clock;
  readonly modelTimeoutMs?: number;
}): InterpretChange => {
  const { repositories, clock } = dependencies;
  // Guarding here as well means a caller cannot hand in an unguarded provider.
  const model = guardModelPort(
    dependencies.model,
    dependencies.modelTimeoutMs === undefined ? {} : { timeoutMs: dependencies.modelTimeoutMs },
  );

  return async (input) => {
    const trace = input.correlationId === undefined ? {} : { correlationId: input.correlationId };
    const text = input.text.trim();
    if (text.length === 0 || text.length > 2000) {
      return fail(
        "INVALID_INPUT",
        "A change must be described in one to two thousand characters.",
        { ...trace, nextStep: "Describe the change in a sentence." },
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

    const context = interpretationContextFor(
      state,
      localDateIn(state.production.timezone, clock.now()),
    );
    let interpreted;
    try {
      interpreted = await model.interpretChange({
        productionId: input.productionId,
        text,
        context,
      });
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      const transient = error.code === "PROVIDER_ERROR" || error.code === "TIMEOUT";
      return fail(
        "INTERNAL_ERROR",
        transient
          ? "The model did not answer."
          : "The model produced an answer that could not be used.",
        {
          ...trace,
          actual: error.code,
          nextStep: transient
            ? "Retry once; if it persists, report the correlation ID."
            : "Rephrase the change, or enter it as a typed change directly.",
        },
      );
    }

    if (interpreted.kind === "UNSUPPORTED") {
      return fail("UNSUPPORTED_CHANGE", interpreted.reason, {
        ...trace,
        nextStep:
          "Describe a cast or location becoming unavailable on a date, or a scene needing something.",
      });
    }

    const index = indexProduction(state);
    const changes =
      interpreted.kind === "RESOLVED"
        ? [interpreted.change]
        : interpreted.options.map((option) => option.change);
    for (const change of changes) {
      const missing = firstMissingReference(index, change);
      if (missing !== null) {
        return fail(
          "ENTITY_NOT_FOUND",
          `The interpretation named ${missing.kind} ${missing.id}, which this production does not have.`,
          {
            ...trace,
            actual: missing.id,
            nextStep: `Resolve the ${missing.kind} with ${missing.lookupTool}.`,
          },
        );
      }
    }

    return succeed(
      interpreted.kind === "RESOLVED"
        ? {
            kind: "RESOLVED",
            change: interpreted.change,
            confidence: interpreted.confidence,
            ...(interpreted.rationale === undefined ? {} : { rationale: interpreted.rationale }),
          }
        : { kind: "AMBIGUOUS", question: interpreted.question, options: interpreted.options },
    );
  };
};
