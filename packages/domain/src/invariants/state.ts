import type { Conflict, EntityId, LocalDate, Task } from "@pca/contracts";

import { isBlockedOn } from "../dates";
import type { ProductionIndex } from "../production-state";
import type { InvariantViolation } from "./types";

/**
 * State invariants (DOMAIN.md INV-1 to INV-4).
 *
 * Each function inspects a production snapshot and returns every violation it
 * finds. They are total: nothing throws, because a caller wants the full list
 * of what is wrong, not the first thing that happened to be checked.
 */

const violation = (
  invariant: InvariantViolation["invariant"],
  conflict: Conflict,
): InvariantViolation => ({ invariant, conflict });

/**
 * INV-1: a scene is not validly scheduled on a day when a required cast member
 * is unavailable.
 */
export const checkCastAvailability = (index: ProductionIndex): InvariantViolation[] => {
  const violations: InvariantViolation[] = [];

  for (const shootDay of index.state.shootDays) {
    for (const sceneId of shootDay.sceneIds) {
      const scene = index.sceneById.get(sceneId);
      if (scene === undefined) {
        continue; // Reported by INV-3 instead; do not report the same fact twice.
      }
      for (const castId of scene.requiredCastIds) {
        const cast = index.castById.get(castId);
        if (cast === undefined) {
          continue; // Reported by INV-3.
        }
        if (isBlockedOn(cast.unavailable, shootDay.date)) {
          violations.push(
            violation("INV-1", {
              code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
              entityType: "SCENE",
              entityId: scene.id,
              date: shootDay.date,
              detail: `Scene ${scene.sceneNumber} is scheduled on ${shootDay.date} but ${cast.name} is unavailable that day.`,
            }),
          );
        }
      }
    }
  }

  return violations;
};

/**
 * INV-2: a scene is not validly scheduled on a day when its location is
 * unavailable.
 */
export const checkLocationAvailability = (index: ProductionIndex): InvariantViolation[] => {
  const violations: InvariantViolation[] = [];

  for (const shootDay of index.state.shootDays) {
    for (const sceneId of shootDay.sceneIds) {
      const scene = index.sceneById.get(sceneId);
      if (scene === undefined) {
        continue;
      }
      const location = index.locationById.get(scene.locationId);
      if (location === undefined) {
        continue;
      }
      if (isBlockedOn(location.unavailable, shootDay.date)) {
        violations.push(
          violation("INV-2", {
            code: "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
            entityType: "SCENE",
            entityId: scene.id,
            date: shootDay.date,
            detail: `Scene ${scene.sceneNumber} is scheduled on ${shootDay.date} at ${location.name}, which is unavailable that day.`,
          }),
        );
      }
    }
  }

  return violations;
};

const unknownReference = (
  entityType: Conflict["entityType"],
  entityId: EntityId,
  detail: string,
  date?: LocalDate,
): Conflict => ({
  code: "UNKNOWN_ENTITY_REFERENCE",
  entityType,
  entityId,
  ...(date === undefined ? {} : { date }),
  detail,
});

/**
 * INV-3: a scene must reference entities that exist, and may sit on at most one
 * shoot day. A scene scheduled twice is a scheduling corruption, not a plan.
 */
export const checkSceneIntegrity = (index: ProductionIndex): InvariantViolation[] => {
  const violations: InvariantViolation[] = [];

  for (const scene of index.state.scenes) {
    if (!index.locationById.has(scene.locationId)) {
      violations.push(
        violation(
          "INV-3",
          unknownReference(
            "SCENE",
            scene.id,
            `Scene ${scene.sceneNumber} references location ${scene.locationId}, which does not exist in this production.`,
          ),
        ),
      );
    }

    for (const castId of scene.requiredCastIds) {
      if (!index.castById.has(castId)) {
        violations.push(
          violation(
            "INV-3",
            unknownReference(
              "SCENE",
              scene.id,
              `Scene ${scene.sceneNumber} requires cast ${castId}, which does not exist in this production.`,
            ),
          ),
        );
      }
    }

    for (const requirementId of scene.requirementIds) {
      if (!index.requirementById.has(requirementId)) {
        violations.push(
          violation(
            "INV-3",
            unknownReference(
              "SCENE",
              scene.id,
              `Scene ${scene.sceneNumber} references requirement ${requirementId}, which does not exist in this production.`,
            ),
          ),
        );
      }
    }
  }

  for (const shootDay of index.state.shootDays) {
    for (const sceneId of shootDay.sceneIds) {
      if (!index.sceneById.has(sceneId)) {
        violations.push(
          violation(
            "INV-3",
            unknownReference(
              "SHOOT_DAY",
              shootDay.id,
              `Shoot day ${shootDay.date} schedules scene ${sceneId}, which does not exist in this production.`,
              shootDay.date,
            ),
          ),
        );
      }
    }
  }

  for (const [sceneId, shootDays] of index.shootDaysBySceneId) {
    if (shootDays.length > 1) {
      const dates = shootDays.map((shootDay) => shootDay.date).join(", ");
      violations.push(
        violation("INV-3", {
          code: "SCENE_ALREADY_ON_SHOOT_DAY",
          entityType: "SCENE",
          entityId: sceneId,
          detail: `Scene ${sceneId} is scheduled on more than one shoot day: ${dates}.`,
        }),
      );
    }
  }

  for (const callSheet of index.state.callSheets) {
    if (!index.shootDayById.has(callSheet.shootDayId)) {
      violations.push(
        violation(
          "INV-3",
          unknownReference(
            "CALL_SHEET",
            callSheet.id,
            `Call sheet ${callSheet.id} references shoot day ${callSheet.shootDayId}, which does not exist in this production.`,
          ),
        ),
      );
    }
  }

  for (const requirement of index.state.requirements) {
    if (!index.sceneById.has(requirement.sceneId)) {
      violations.push(
        violation(
          "INV-3",
          unknownReference(
            "REQUIREMENT",
            requirement.id,
            `Requirement ${requirement.id} references scene ${requirement.sceneId}, which does not exist in this production.`,
          ),
        ),
      );
    }
  }

  // TASK-909 (code review #10): a task links into the production too, so an
  // orphan task is a corruption INV-3 must report on the stored state itself,
  // not only refuse at the operation that would have created it.
  for (const task of index.state.tasks) {
    if (!taskTargetExists(index, task.relatedEntityType, task.relatedEntityId)) {
      violations.push(
        violation(
          "INV-3",
          unknownReference(
            "TASK",
            task.id,
            `Task "${task.title}" references ${task.relatedEntityType} ${task.relatedEntityId}, which does not exist in this production.`,
          ),
        ),
      );
    }
  }

  return violations;
};

const taskTargetExists = (
  index: ProductionIndex,
  type: Task["relatedEntityType"],
  id: EntityId,
): boolean => {
  switch (type) {
    case "SCENE":
      return index.sceneById.has(id);
    case "SHOOT_DAY":
      return index.shootDayById.has(id);
    case "CALL_SHEET":
      return index.callSheetById.has(id);
    case "REQUIREMENT":
      return index.requirementById.has(id);
  }
};

/**
 * INV-4: entities from one production may not be referenced by another.
 *
 * This is the tenancy boundary. It is checked on the snapshot itself so a
 * mis-scoped repository query is caught here rather than surfacing as a
 * mysteriously missing scene later.
 */
export const checkProductionIsolation = (index: ProductionIndex): InvariantViolation[] => {
  const productionId = index.state.production.id;
  const violations: InvariantViolation[] = [];

  const check = (
    entityType: Conflict["entityType"],
    entityId: EntityId,
    ownerProductionId: EntityId,
  ): void => {
    if (ownerProductionId !== productionId) {
      violations.push(
        violation("INV-4", {
          code: "CROSS_PRODUCTION_REFERENCE",
          entityType,
          entityId,
          detail: `${entityType} ${entityId} belongs to production ${ownerProductionId} but appears in the snapshot for ${productionId}.`,
        }),
      );
    }
  };

  for (const scene of index.state.scenes) check("SCENE", scene.id, scene.productionId);
  for (const cast of index.state.castMembers) check("CAST_MEMBER", cast.id, cast.productionId);
  for (const location of index.state.locations) {
    check("LOCATION", location.id, location.productionId);
  }
  for (const requirement of index.state.requirements) {
    check("REQUIREMENT", requirement.id, requirement.productionId);
  }
  for (const shootDay of index.state.shootDays) {
    check("SHOOT_DAY", shootDay.id, shootDay.productionId);
  }
  for (const callSheet of index.state.callSheets) {
    check("CALL_SHEET", callSheet.id, callSheet.productionId);
  }
  for (const task of index.state.tasks) check("TASK", task.id, task.productionId);

  return violations;
};

/** Every state invariant, in INV order. */
export const checkStateInvariants = (index: ProductionIndex): InvariantViolation[] => [
  ...checkCastAvailability(index),
  ...checkLocationAvailability(index),
  ...checkSceneIntegrity(index),
  ...checkProductionIsolation(index),
];

/** Convenience for callers that only need a yes or no. */
export const isProductionStateValid = (index: ProductionIndex): boolean =>
  checkStateInvariants(index).length === 0;
