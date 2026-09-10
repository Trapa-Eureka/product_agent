import type {
  CallSheet,
  CastMember,
  EntityId,
  Location,
  LocalDate,
  Production,
  Requirement,
  Scene,
  ShootDay,
  Task,
  TaskRelatedEntityType,
} from "@pca/contracts";

/**
 * An immutable snapshot of one production.
 *
 * Every deterministic rule in this package reads a snapshot rather than a
 * database. That is what lets impact analysis, simulation, and validation run
 * identically against fixtures, an in-memory store, Mongo, or a file, and what
 * makes simulation genuinely side-effect free.
 */
export type ProductionState = {
  readonly production: Production;
  readonly scenes: readonly Scene[];
  readonly castMembers: readonly CastMember[];
  readonly locations: readonly Location[];
  readonly requirements: readonly Requirement[];
  readonly shootDays: readonly ShootDay[];
  readonly callSheets: readonly CallSheet[];
  readonly tasks: readonly Task[];
};

const taskKey = (type: TaskRelatedEntityType, id: EntityId): string => `${type}:${id}`;

const groupBy = <TItem, TKey>(
  items: readonly TItem[],
  keyOf: (item: TItem) => TKey,
): Map<TKey, TItem[]> => {
  const grouped = new Map<TKey, TItem[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return grouped;
};

/**
 * Lookup tables over a snapshot.
 *
 * Dependency traversal walks scene to cast to shoot day to call sheet to task
 * repeatedly. Building the indexes once keeps that traversal linear instead of
 * quadratic, and keeps the rules readable.
 */
export type ProductionIndex = {
  readonly state: ProductionState;
  readonly sceneById: ReadonlyMap<EntityId, Scene>;
  readonly sceneByNumber: ReadonlyMap<string, Scene>;
  readonly castById: ReadonlyMap<EntityId, CastMember>;
  readonly locationById: ReadonlyMap<EntityId, Location>;
  readonly requirementById: ReadonlyMap<EntityId, Requirement>;
  readonly requirementsBySceneId: ReadonlyMap<EntityId, readonly Requirement[]>;
  readonly shootDayById: ReadonlyMap<EntityId, ShootDay>;
  readonly shootDayByDate: ReadonlyMap<LocalDate, ShootDay>;
  /** Shoot days a scene appears on. More than one is an INV-3 violation, not a feature. */
  readonly shootDaysBySceneId: ReadonlyMap<EntityId, readonly ShootDay[]>;
  readonly callSheetById: ReadonlyMap<EntityId, CallSheet>;
  readonly callSheetsByShootDayId: ReadonlyMap<EntityId, readonly CallSheet[]>;
  readonly tasksByRelatedEntity: ReadonlyMap<string, readonly Task[]>;
  readonly scenesByLocationId: ReadonlyMap<EntityId, readonly Scene[]>;
  readonly scenesByRequiredCastId: ReadonlyMap<EntityId, readonly Scene[]>;
};

export const indexProduction = (state: ProductionState): ProductionIndex => {
  const scenesByRequiredCastId = new Map<EntityId, Scene[]>();
  for (const scene of state.scenes) {
    for (const castId of scene.requiredCastIds) {
      const bucket = scenesByRequiredCastId.get(castId);
      if (bucket === undefined) {
        scenesByRequiredCastId.set(castId, [scene]);
      } else {
        bucket.push(scene);
      }
    }
  }

  const shootDaysBySceneId = new Map<EntityId, ShootDay[]>();
  for (const shootDay of state.shootDays) {
    for (const sceneId of shootDay.sceneIds) {
      const bucket = shootDaysBySceneId.get(sceneId);
      if (bucket === undefined) {
        shootDaysBySceneId.set(sceneId, [shootDay]);
      } else {
        bucket.push(shootDay);
      }
    }
  }

  return {
    state,
    sceneById: new Map(state.scenes.map((scene) => [scene.id, scene])),
    sceneByNumber: new Map(state.scenes.map((scene) => [scene.sceneNumber, scene])),
    castById: new Map(state.castMembers.map((cast) => [cast.id, cast])),
    locationById: new Map(state.locations.map((location) => [location.id, location])),
    requirementById: new Map(
      state.requirements.map((requirement) => [requirement.id, requirement]),
    ),
    requirementsBySceneId: groupBy(state.requirements, (requirement) => requirement.sceneId),
    shootDayById: new Map(state.shootDays.map((shootDay) => [shootDay.id, shootDay])),
    shootDayByDate: new Map(state.shootDays.map((shootDay) => [shootDay.date, shootDay])),
    shootDaysBySceneId,
    callSheetById: new Map(state.callSheets.map((callSheet) => [callSheet.id, callSheet])),
    callSheetsByShootDayId: groupBy(state.callSheets, (callSheet) => callSheet.shootDayId),
    tasksByRelatedEntity: groupBy(state.tasks, (task) =>
      taskKey(task.relatedEntityType, task.relatedEntityId),
    ),
    scenesByLocationId: groupBy(state.scenes, (scene) => scene.locationId),
    scenesByRequiredCastId,
  };
};

/** The single shoot day a scene sits on, or null when it is unscheduled. */
export const scheduledShootDay = (index: ProductionIndex, sceneId: EntityId): ShootDay | null =>
  index.shootDaysBySceneId.get(sceneId)?.[0] ?? null;

export const tasksFor = (
  index: ProductionIndex,
  relatedEntityType: TaskRelatedEntityType,
  relatedEntityId: EntityId,
): readonly Task[] =>
  index.tasksByRelatedEntity.get(taskKey(relatedEntityType, relatedEntityId)) ?? [];

export const requirementsFor = (
  index: ProductionIndex,
  sceneId: EntityId,
): readonly Requirement[] => index.requirementsBySceneId.get(sceneId) ?? [];

export const callSheetsFor = (index: ProductionIndex, shootDayId: EntityId): readonly CallSheet[] =>
  index.callSheetsByShootDayId.get(shootDayId) ?? [];

export const scenesRequiringCast = (index: ProductionIndex, castId: EntityId): readonly Scene[] =>
  index.scenesByRequiredCastId.get(castId) ?? [];

export const scenesAtLocation = (index: ProductionIndex, locationId: EntityId): readonly Scene[] =>
  index.scenesByLocationId.get(locationId) ?? [];
