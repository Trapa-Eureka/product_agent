import type { RepositorySet, UseCaseResult } from "@pca/application";
import { fail, succeed } from "@pca/application";
import type { EntityId, McpToolOutput, Scene } from "@pca/contracts";
import type { ProductionIndex, ProductionState } from "@pca/domain";
import {
  blockedDatesWithin,
  callSheetsFor,
  indexProduction,
  requirementsFor,
  scheduledShootDay,
  tasksFor,
} from "@pca/domain";

import type { CallContext, ToolHandlers } from "../server";

/**
 * Read tools (MCP.md §4).
 *
 * Every read loads the production snapshot and answers from the index. None
 * touches a repository other than to load; none audits. The answers are the
 * data, in canonical order, so an agent that calls twice sees the same thing
 * twice.
 *
 * Resolution tools return every candidate rather than the best one. Picking
 * the wrong "Sarah" silently is worse than handing the ambiguity back
 * (DESIGN.md §3), and the intake use case will refuse an ID that was guessed.
 */

type Loaded = { readonly state: ProductionState; readonly index: ProductionIndex };

const loadOrFail = async (
  repositories: RepositorySet,
  productionId: EntityId,
  call: CallContext,
): Promise<UseCaseResult<Loaded>> => {
  const state = await repositories.productions.loadState(productionId);
  if (state === null) {
    return fail("ENTITY_NOT_FOUND", `Production ${productionId} does not exist.`, {
      correlationId: call.correlationId,
      actual: productionId,
      nextStep: "Use a production ID this server was started for.",
    });
  }
  return succeed({ state, index: indexProduction(state) });
};

const notFound = <T>(
  kind: string,
  id: string,
  productionId: EntityId,
  call: CallContext,
  lookupTool: string,
): UseCaseResult<T> =>
  fail("ENTITY_NOT_FOUND", `No ${kind} ${id} exists in production ${productionId}.`, {
    correlationId: call.correlationId,
    actual: id,
    nextStep: `Resolve the ${kind} with ${lookupTool} and use the ID it returns.`,
  });

type NormalizedScene = McpToolOutput<"get_scene">;

/**
 * A scene with what it depends on, read from one index. `null` when the
 * scene's location does not exist, which INV-3 forbids; the caller decides
 * whether that is an error (`get_scene`) or a scene to leave unresolved
 * (`get_schedule` with `includeScenes`, where one corrupt scene must not
 * hide the rest of the schedule).
 */
const normalizeScene = (index: ProductionIndex, scene: Scene): NormalizedScene | null => {
  const location = index.locationById.get(scene.locationId);
  if (location === undefined) return null;
  return {
    scene,
    location,
    requiredCast: scene.requiredCastIds
      .map((castId) => index.castById.get(castId))
      .filter((cast): cast is NonNullable<typeof cast> => cast !== undefined),
    requirements: [...requirementsFor(index, scene.id)],
    scheduledShootDayId: scheduledShootDay(index, scene.id)?.id ?? null,
  };
};

/** Case-insensitive, whitespace-tolerant containment; the whole of entity resolution. */
const matches = (haystack: string | undefined, query: string): boolean =>
  haystack !== undefined && haystack.toLowerCase().includes(query.trim().toLowerCase());

export const createReadToolHandlers = (dependencies: {
  readonly repositories: RepositorySet;
}): ToolHandlers => {
  const { repositories } = dependencies;

  return {
    get_production: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const { id, name, timezone, version } = loaded.value.state.production;
      return succeed({ id, name, timezone, version });
    },

    get_scene: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const { index } = loaded.value;

      const scene =
        input.sceneId !== undefined
          ? index.sceneById.get(input.sceneId)
          : index.sceneByNumber.get(input.sceneNumber ?? "");
      const asked = input.sceneId ?? input.sceneNumber ?? "";
      if (scene === undefined) {
        return notFound("scene", asked, input.productionId, call, "get_schedule");
      }

      const normalized = normalizeScene(index, scene);
      if (normalized === null) {
        return fail(
          "INTERNAL_ERROR",
          `Scene ${scene.sceneNumber} references location ${scene.locationId}, which does not exist.`,
          {
            correlationId: call.correlationId,
            nextStep: "Report this production to an operator; INV-3 is violated.",
          },
        );
      }
      return succeed(normalized);
    },

    find_cast: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const candidates = loaded.value.state.castMembers
        .filter((cast) => matches(cast.name, input.query) || matches(cast.roleName, input.query))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((cast) => ({
          id: cast.id,
          name: cast.name,
          ...(cast.roleName === undefined ? {} : { roleName: cast.roleName }),
        }));
      return succeed({ candidates });
    },

    find_location: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const candidates = loaded.value.state.locations
        .filter((location) => matches(location.name, input.query))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((location) => ({ id: location.id, name: location.name }));
      return succeed({ candidates });
    },

    get_cast_availability: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const cast = loaded.value.index.castById.get(input.castId);
      if (cast === undefined) {
        return notFound("cast member", input.castId, input.productionId, call, "find_cast");
      }
      return succeed({
        entityId: cast.id,
        from: input.from,
        to: input.to,
        unavailableDates: blockedDatesWithin(cast.unavailable, input.from, input.to),
      });
    },

    get_location_availability: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const location = loaded.value.index.locationById.get(input.locationId);
      if (location === undefined) {
        return notFound("location", input.locationId, input.productionId, call, "find_location");
      }
      return succeed({
        entityId: location.id,
        from: input.from,
        to: input.to,
        unavailableDates: blockedDatesWithin(location.unavailable, input.from, input.to),
      });
    },

    get_schedule: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const { state, index } = loaded.value;

      let shootDays = [...state.shootDays];
      if (input.sceneId !== undefined) {
        if (!index.sceneById.has(input.sceneId)) {
          return notFound("scene", input.sceneId, input.productionId, call, "get_scene");
        }
        const day = scheduledShootDay(index, input.sceneId);
        shootDays = day === null ? [] : [day];
      }
      if (input.date !== undefined) {
        shootDays = shootDays.filter((day) => day.date === input.date);
      }
      shootDays.sort((left, right) => left.date.localeCompare(right.date));

      if (input.includeScenes !== true) {
        return succeed({ productionVersion: state.production.version, shootDays });
      }
      // TASK-913 (code review #16): the console used to follow this call with
      // one get_scene per scene, each loading the whole production again.
      // Resolve them here, from the index already in hand, distinct and in
      // day order; a scene ID the production cannot resolve is left out and
      // the caller shows it by ID.
      const scenes: NormalizedScene[] = [];
      const seen = new Set<EntityId>();
      for (const day of shootDays) {
        for (const sceneId of day.sceneIds) {
          if (seen.has(sceneId)) continue;
          seen.add(sceneId);
          const scene = index.sceneById.get(sceneId);
          const normalized = scene === undefined ? null : normalizeScene(index, scene);
          if (normalized !== null) scenes.push(normalized);
        }
      }
      return succeed({ productionVersion: state.production.version, shootDays, scenes });
    },

    get_call_sheet: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const { index } = loaded.value;
      if (!index.shootDayById.has(input.shootDayId)) {
        return notFound("shoot day", input.shootDayId, input.productionId, call, "get_schedule");
      }
      return succeed({ callSheet: callSheetsFor(index, input.shootDayId)[0] ?? null });
    },

    get_tasks: async (input, call) => {
      const loaded = await loadOrFail(repositories, input.productionId, call);
      if (!loaded.ok) return loaded;
      const { state, index } = loaded.value;

      const hasType = input.relatedEntityType !== undefined;
      const hasId = input.relatedEntityId !== undefined;
      if (hasType !== hasId) {
        return fail(
          "INVALID_INPUT",
          "relatedEntityType and relatedEntityId must be given together.",
          {
            correlationId: call.correlationId,
            nextStep: "Provide both, or neither to list every task.",
          },
        );
      }

      const tasks =
        input.relatedEntityType !== undefined && input.relatedEntityId !== undefined
          ? [...tasksFor(index, input.relatedEntityType, input.relatedEntityId)]
          : [...state.tasks];
      tasks.sort((left, right) => left.id.localeCompare(right.id));
      return succeed({ tasks });
    },
  };
};
