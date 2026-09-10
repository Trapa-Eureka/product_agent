import type { CastMember, EntityId, Location, Scene, ShootDay, TypedChange } from "@pca/contracts";

import { isBlockedOn, isDateWithin } from "../dates";
import type { ProductionIndex } from "../production-state";
import {
  callSheetsFor,
  requirementsFor,
  scenesAtLocation,
  scenesRequiringCast,
  scheduledShootDay,
  tasksFor,
} from "../production-state";
import { findEquivalentRequirement } from "../requirements";
import type { ImpactAnalysis } from "./collector";
import { ImpactCollector } from "./collector";

/**
 * Deterministic impact analysis (SPEC.md FR-2, DOMAIN.md §5).
 *
 * Given a production snapshot and a typed change, walk the dependency graph
 * and report every entity the change touches, with a machine-readable reason
 * for each. No model is consulted. A model may later put these findings into
 * prose, but it cannot add to them, and the "WHY" a coordinator reads is
 * derived from the reason codes recorded here.
 *
 * Only entities the change actually reaches are reported. A scene that needs
 * Sarah but shoots on Monday is untouched by Sarah being unavailable on
 * Friday, so it does not appear. The golden scenarios assert exact sets, and
 * "exact" is the point: an over-eager list teaches a coordinator to skim.
 */

/** A scene that can no longer proceed as planned, and the day it sits on. */
type AffectedScene = {
  readonly scene: Scene;
  readonly shootDay: ShootDay;
};

const sceneLabel = (scene: Scene): string => `Scene ${scene.sceneNumber}`;

const listSceneNumbers = (scenes: readonly Scene[]): string =>
  scenes.map((scene) => scene.sceneNumber).join(", ");

/**
 * The downstream ripple every scene-level disruption shares: the day it sits
 * on, the call sheet derived from that day, the other cast and the location
 * bound to it, and the open tasks hanging off any of those.
 */
const propagateFromScenes = (
  index: ProductionIndex,
  collector: ImpactCollector,
  affected: readonly AffectedScene[],
  options: {
    readonly subjectCastId?: EntityId;
    readonly subjectLocationId?: EntityId;
    readonly includeAttachedEntities: boolean;
    readonly dayExplanation: (shootDay: ShootDay, scenes: readonly Scene[]) => string;
  },
): void => {
  const scenesByDay = new Map<EntityId, { shootDay: ShootDay; scenes: Scene[] }>();
  for (const { scene, shootDay } of affected) {
    const bucket = scenesByDay.get(shootDay.id);
    if (bucket === undefined) {
      scenesByDay.set(shootDay.id, { shootDay, scenes: [scene] });
    } else {
      bucket.scenes.push(scene);
    }
  }

  for (const { shootDay, scenes } of scenesByDay.values()) {
    collector.add({
      entityType: "SHOOT_DAY",
      entityId: shootDay.id,
      reasonCode: "SHOOT_DAY_CONTAINS_AFFECTED_SCENE",
      explanation: options.dayExplanation(shootDay, scenes),
      severity: "WARNING",
    });

    for (const callSheet of callSheetsFor(index, shootDay.id)) {
      collector.add({
        entityType: "CALL_SHEET",
        entityId: callSheet.id,
        reasonCode: "CALL_SHEET_DERIVED_FROM_AFFECTED_SHOOT_DAY",
        explanation: `Call sheet ${callSheet.id} is derived from shoot day ${shootDay.date} and must be regenerated.`,
        severity: "WARNING",
      });
      addOpenTasks(index, collector, "CALL_SHEET", callSheet.id, `call sheet ${callSheet.id}`);
    }

    addOpenTasks(index, collector, "SHOOT_DAY", shootDay.id, `shoot day ${shootDay.date}`);
  }

  for (const { scene } of affected) {
    addOpenTasks(index, collector, "SCENE", scene.id, sceneLabel(scene));

    if (!options.includeAttachedEntities) {
      continue;
    }

    for (const castId of scene.requiredCastIds) {
      if (castId === options.subjectCastId) {
        continue;
      }
      const cast = index.castById.get(castId);
      if (cast !== undefined) {
        collector.add({
          entityType: "CAST_MEMBER",
          entityId: cast.id,
          reasonCode: "CAST_ATTACHED_TO_AFFECTED_SCENE",
          explanation: `${cast.name} is required by ${sceneLabel(scene)}, so any move affects their schedule.`,
          severity: "INFO",
        });
      }
    }

    if (scene.locationId !== options.subjectLocationId) {
      const location = index.locationById.get(scene.locationId);
      if (location !== undefined) {
        collector.add({
          entityType: "LOCATION",
          entityId: location.id,
          reasonCode: "LOCATION_ATTACHED_TO_AFFECTED_SCENE",
          explanation: `${location.name} hosts ${sceneLabel(scene)}, so any move must keep it available.`,
          severity: "INFO",
        });
      }
    }
  }
};

/** Done tasks need no attention; open ones may now be pointing at a stale plan. */
const addOpenTasks = (
  index: ProductionIndex,
  collector: ImpactCollector,
  relatedEntityType: "SCENE" | "SHOOT_DAY" | "CALL_SHEET" | "REQUIREMENT",
  relatedEntityId: EntityId,
  relatedLabel: string,
): void => {
  for (const task of tasksFor(index, relatedEntityType, relatedEntityId)) {
    if (task.status !== "OPEN") {
      continue;
    }
    collector.add({
      entityType: "TASK",
      entityId: task.id,
      reasonCode: "TASK_LINKED_TO_AFFECTED_ENTITY",
      explanation: `Task "${task.title}" is linked to ${relatedLabel}, which is affected.`,
      severity: "INFO",
    });
  }
};

const analyzeCastUnavailable = (
  index: ProductionIndex,
  change: Extract<TypedChange, { type: "CAST_UNAVAILABLE" }>,
): ImpactAnalysis => {
  const collector = new ImpactCollector();
  const cast = index.castById.get(change.castId);
  if (cast === undefined) {
    return unknownReference(collector, "CAST_MEMBER", change.castId);
  }

  const affected: AffectedScene[] = [];
  for (const scene of scenesRequiringCast(index, cast.id)) {
    const shootDay = scheduledShootDay(index, scene.id);
    if (shootDay === null || !isDateWithin(shootDay.date, change.unavailable)) {
      continue;
    }
    affected.push({ scene, shootDay });
    collector.add({
      entityType: "SCENE",
      entityId: scene.id,
      reasonCode: "SCENE_REQUIRES_UNAVAILABLE_CAST",
      explanation: `${sceneLabel(scene)} requires ${cast.name} and is scheduled on ${shootDay.date}, when ${cast.name} is unavailable.`,
      severity: "BLOCKING",
    });
    collector.conflict({
      code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
      entityType: "SCENE",
      entityId: scene.id,
      date: shootDay.date,
      detail: `${cast.name} is unavailable on ${shootDay.date} but ${sceneLabel(scene)} is scheduled that day.`,
    });
  }

  propagateFromScenes(index, collector, affected, {
    subjectCastId: cast.id,
    includeAttachedEntities: true,
    dayExplanation: (shootDay, scenes) =>
      `Shoot day ${shootDay.date} contains ${scenes.length === 1 ? "scene" : "scenes"} ${listSceneNumbers(scenes)}, which cannot proceed while ${cast.name} is unavailable.`,
  });

  return collector.result();
};

const analyzeLocationUnavailable = (
  index: ProductionIndex,
  change: Extract<TypedChange, { type: "LOCATION_UNAVAILABLE" }>,
): ImpactAnalysis => {
  const collector = new ImpactCollector();
  const location = index.locationById.get(change.locationId);
  if (location === undefined) {
    return unknownReference(collector, "LOCATION", change.locationId);
  }

  const affected: AffectedScene[] = [];
  for (const scene of scenesAtLocation(index, location.id)) {
    const shootDay = scheduledShootDay(index, scene.id);
    if (shootDay === null || !isDateWithin(shootDay.date, change.unavailable)) {
      continue;
    }
    affected.push({ scene, shootDay });
    collector.add({
      entityType: "SCENE",
      entityId: scene.id,
      reasonCode: "SCENE_AT_UNAVAILABLE_LOCATION",
      explanation: `${sceneLabel(scene)} shoots at ${location.name} and is scheduled on ${shootDay.date}, when ${location.name} is unavailable.`,
      severity: "BLOCKING",
    });
    collector.conflict({
      code: "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
      entityType: "SCENE",
      entityId: scene.id,
      date: shootDay.date,
      detail: `${location.name} is unavailable on ${shootDay.date} but ${sceneLabel(scene)} is scheduled there that day.`,
    });
  }

  propagateFromScenes(index, collector, affected, {
    subjectLocationId: location.id,
    includeAttachedEntities: true,
    dayExplanation: (shootDay, scenes) =>
      `Shoot day ${shootDay.date} contains ${scenes.length === 1 ? "scene" : "scenes"} ${listSceneNumbers(scenes)}, which cannot proceed while ${location.name} is unavailable.`,
  });

  return collector.result();
};

const analyzeSceneRequirementChanged = (
  index: ProductionIndex,
  change: Extract<TypedChange, { type: "SCENE_REQUIREMENT_CHANGED" }>,
): ImpactAnalysis => {
  const collector = new ImpactCollector();
  const scene = index.sceneById.get(change.sceneId);
  if (scene === undefined) {
    return unknownReference(collector, "SCENE", change.sceneId);
  }

  const { type, name } = change.requirement;
  const existing = findEquivalentRequirement(requirementsFor(index, scene.id), change.requirement);

  if (existing !== null) {
    collector.add({
      entityType: "REQUIREMENT",
      entityId: existing.id,
      reasonCode: "SCENE_REQUIREMENT_ALREADY_PRESENT",
      explanation: `${sceneLabel(scene)} already has the ${type} requirement "${existing.name}" (${existing.status}); nothing needs adding.`,
      severity: "INFO",
    });
    addOpenTasks(index, collector, "REQUIREMENT", existing.id, `requirement "${existing.name}"`);
    return collector.result();
  }

  collector.add({
    entityType: "SCENE",
    entityId: scene.id,
    reasonCode: "SCENE_REQUIREMENT_ADDED",
    explanation: `${sceneLabel(scene)} gains a new ${type} requirement: ${name}.`,
    severity: "INFO",
  });

  const shootDay = scheduledShootDay(index, scene.id);
  if (shootDay !== null) {
    propagateFromScenes(index, collector, [{ scene, shootDay }], {
      includeAttachedEntities: false,
      dayExplanation: (day) =>
        `Shoot day ${day.date} contains ${sceneLabel(scene)}; the ${type} "${name}" must be ready by then.`,
    });
  } else {
    addOpenTasks(index, collector, "SCENE", scene.id, sceneLabel(scene));
  }

  return collector.result();
};

const analyzeScheduleChanged = (
  index: ProductionIndex,
  change: Extract<TypedChange, { type: "SCHEDULE_CHANGED" }>,
): ImpactAnalysis => {
  const collector = new ImpactCollector();
  const target = index.shootDayById.get(change.toShootDayId);
  if (target === undefined) {
    return unknownReference(collector, "SHOOT_DAY", change.toShootDayId);
  }

  const moving: AffectedScene[] = [];
  for (const sceneId of change.sceneIds) {
    const scene = index.sceneById.get(sceneId);
    if (scene === undefined) {
      collector.conflict(unknownConflict("SCENE", sceneId));
      continue;
    }

    const source = scheduledShootDay(index, scene.id);
    if (source?.id === target.id) {
      collector.conflict({
        code: "SCENE_ALREADY_ON_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scene.id,
        date: target.date,
        detail: `${sceneLabel(scene)} is already scheduled on ${target.date}.`,
      });
      continue;
    }

    collector.add({
      entityType: "SCENE",
      entityId: scene.id,
      reasonCode: "SCENE_RESCHEDULED",
      explanation:
        source === null
          ? `${sceneLabel(scene)} is scheduled onto ${target.date}.`
          : `${sceneLabel(scene)} moves from ${source.date} to ${target.date}.`,
      severity: "INFO",
    });
    if (source !== null) {
      moving.push({ scene, shootDay: source });
    }

    checkTargetDayAvailability(index, collector, scene, target);
  }

  propagateFromScenes(index, collector, moving, {
    includeAttachedEntities: false,
    dayExplanation: (day, scenes) =>
      `Shoot day ${day.date} loses ${scenes.length === 1 ? "scene" : "scenes"} ${listSceneNumbers(scenes)}.`,
  });

  const arriving = change.sceneIds
    .map((sceneId) => index.sceneById.get(sceneId))
    .filter((scene): scene is Scene => scene !== undefined)
    .filter((scene) => scheduledShootDay(index, scene.id)?.id !== target.id);
  if (arriving.length > 0) {
    {
      collector.add({
        entityType: "SHOOT_DAY",
        entityId: target.id,
        reasonCode: "SHOOT_DAY_CONTAINS_AFFECTED_SCENE",
        explanation: `Shoot day ${target.date} gains ${arriving.length === 1 ? "scene" : "scenes"} ${listSceneNumbers(arriving)}.`,
        severity: "WARNING",
      });
      for (const callSheet of callSheetsFor(index, target.id)) {
        collector.add({
          entityType: "CALL_SHEET",
          entityId: callSheet.id,
          reasonCode: "CALL_SHEET_DERIVED_FROM_AFFECTED_SHOOT_DAY",
          explanation: `Call sheet ${callSheet.id} is derived from shoot day ${target.date} and must be regenerated.`,
          severity: "WARNING",
        });
        addOpenTasks(index, collector, "CALL_SHEET", callSheet.id, `call sheet ${callSheet.id}`);
      }
      addOpenTasks(index, collector, "SHOOT_DAY", target.id, `shoot day ${target.date}`);
    }
  }

  return collector.result();
};

/**
 * Whether the cast and location a scene needs are free on the day it is
 * moving to. Available means a warning the coordinator should see ("John is
 * required Monday"); unavailable means the move is blocked.
 */
const checkTargetDayAvailability = (
  index: ProductionIndex,
  collector: ImpactCollector,
  scene: Scene,
  target: ShootDay,
): void => {
  for (const castId of scene.requiredCastIds) {
    const cast = index.castById.get(castId);
    if (cast === undefined) {
      continue;
    }
    const blocked = isBlockedOn(cast.unavailable, target.date);
    collector.add(castOnTargetDay(cast, scene, target, blocked));
    if (blocked) {
      collector.conflict({
        code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scene.id,
        date: target.date,
        detail: `${cast.name} is unavailable on ${target.date}, so ${sceneLabel(scene)} cannot move there.`,
      });
    }
  }

  const location = index.locationById.get(scene.locationId);
  if (location !== undefined) {
    const blocked = isBlockedOn(location.unavailable, target.date);
    collector.add(locationOnTargetDay(location, scene, target, blocked));
    if (blocked) {
      collector.conflict({
        code: "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
        entityType: "SCENE",
        entityId: scene.id,
        date: target.date,
        detail: `${location.name} is unavailable on ${target.date}, so ${sceneLabel(scene)} cannot move there.`,
      });
    }
  }
};

const castOnTargetDay = (
  cast: CastMember,
  scene: Scene,
  target: ShootDay,
  blocked: boolean,
): Parameters<ImpactCollector["add"]>[0] => ({
  entityType: "CAST_MEMBER",
  entityId: cast.id,
  reasonCode: "CAST_REQUIRED_ON_TARGET_DAY",
  explanation: blocked
    ? `${cast.name} is required by ${sceneLabel(scene)} but is unavailable on ${target.date}.`
    : `${cast.name} is required on ${target.date} for ${sceneLabel(scene)}.`,
  severity: blocked ? "BLOCKING" : "WARNING",
});

const locationOnTargetDay = (
  location: Location,
  scene: Scene,
  target: ShootDay,
  blocked: boolean,
): Parameters<ImpactCollector["add"]>[0] => ({
  entityType: "LOCATION",
  entityId: location.id,
  reasonCode: "LOCATION_REQUIRED_ON_TARGET_DAY",
  explanation: blocked
    ? `${location.name} is needed by ${sceneLabel(scene)} but is unavailable on ${target.date}.`
    : `${location.name} is needed on ${target.date} for ${sceneLabel(scene)}.`,
  severity: blocked ? "BLOCKING" : "WARNING",
});

const unknownConflict = (
  entityType: "SCENE" | "CAST_MEMBER" | "LOCATION" | "SHOOT_DAY",
  entityId: EntityId,
) => ({
  code: "UNKNOWN_ENTITY_REFERENCE" as const,
  entityType,
  entityId,
  detail: `${entityType} ${entityId} does not exist in this production.`,
});

/**
 * The engine is total: an unknown reference yields a conflict, not a throw.
 * Intake normally refuses these earlier, but the engine must not depend on it.
 */
const unknownReference = (
  collector: ImpactCollector,
  entityType: "SCENE" | "CAST_MEMBER" | "LOCATION" | "SHOOT_DAY",
  entityId: EntityId,
): ImpactAnalysis => {
  collector.conflict(unknownConflict(entityType, entityId));
  return collector.result();
};

export const analyzeImpact = (index: ProductionIndex, change: TypedChange): ImpactAnalysis => {
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return analyzeCastUnavailable(index, change);
    case "LOCATION_UNAVAILABLE":
      return analyzeLocationUnavailable(index, change);
    case "SCENE_REQUIREMENT_CHANGED":
      return analyzeSceneRequirementChanged(index, change);
    case "SCHEDULE_CHANGED":
      return analyzeScheduleChanged(index, change);
  }
};
