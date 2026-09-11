import type { EntityId, ProposedOperation } from "@pca/contracts";

import { isRangeCovered } from "./dates";
import { callSheetsFor, requirementsFor, tasksFor } from "./production-state";
import type { ProductionIndex } from "./production-state";
import { findEquivalentRequirement, normalizeRequirementName } from "./requirements";

/**
 * Natural idempotency (DOMAIN.md INV-8).
 *
 * A key-based guard stops the same request from being processed twice. This
 * complements it by asking a different question: is the world already in the
 * state this operation would produce? That is what keeps a retry arriving
 * through a different path, or an operator repeating a change by hand, from
 * creating a second identical task or requirement.
 */
export const isOperationAlreadyApplied = (
  index: ProductionIndex,
  operation: ProposedOperation,
): boolean => {
  switch (operation.type) {
    case "RECORD_CAST_UNAVAILABILITY": {
      const cast = index.castById.get(operation.castId);
      return cast !== undefined && isRangeCovered(cast.unavailable, operation.unavailable);
    }

    case "RECORD_LOCATION_UNAVAILABILITY": {
      const location = index.locationById.get(operation.locationId);
      return location !== undefined && isRangeCovered(location.unavailable, operation.unavailable);
    }

    case "MOVE_SCENES": {
      const target = index.shootDayById.get(operation.toShootDayId);
      if (target === undefined) {
        return false;
      }
      const source = index.shootDayById.get(operation.fromShootDayId);
      const targetSceneIds = new Set(target.sceneIds);
      const sourceSceneIds = new Set(source?.sceneIds ?? []);
      return operation.sceneIds.every(
        (sceneId) => targetSceneIds.has(sceneId) && !sourceSceneIds.has(sceneId),
      );
    }

    case "ADD_SCENE_REQUIREMENT": {
      const existing = requirementsFor(index, operation.sceneId);
      return (
        findEquivalentRequirement(existing, {
          type: operation.requirementType,
          name: operation.name,
        }) !== null
      );
    }

    case "CREATE_PREPARATION_TASK": {
      const related = tasksFor(index, operation.relatedEntityType, operation.relatedEntityId);
      const wanted = normalizeRequirementName(operation.title);
      return related.some(
        (task) => task.status === "OPEN" && normalizeRequirementName(task.title) === wanted,
      );
    }

    case "MARK_CALL_SHEET_STALE": {
      const callSheet = index.callSheetById.get(operation.callSheetId);
      // A call sheet that is already a draft is already flagged for regeneration.
      return callSheet !== undefined && callSheet.status === "DRAFT";
    }
  }
};

/**
 * The call sheets a shoot-day change invalidates (TASK-937: the one policy;
 * `runChangeAgent` builds its MARK_CALL_SHEET_STALE operations from this).
 *
 * A published call sheet describes a day that no longer matches the plan, so it
 * must be regenerated rather than quietly left to mislead a crew. A draft is
 * already flagged for regeneration (`isOperationAlreadyApplied` says so), so
 * it is not named again. Each sheet appears once, in the order of the days.
 */
export const staleCallSheetIdsForShootDays = (
  index: ProductionIndex,
  shootDayIds: readonly EntityId[],
): EntityId[] => {
  const ids = new Set<EntityId>();
  for (const shootDayId of shootDayIds) {
    for (const callSheet of callSheetsFor(index, shootDayId)) {
      if (callSheet.status === "PUBLISHED") ids.add(callSheet.id);
    }
  }
  return [...ids];
};
