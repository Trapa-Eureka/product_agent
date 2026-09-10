import type { ProposedOperation } from "@pca/contracts";

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

/** The operations that would still change something, in their original order. */
export const pendingOperations = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
): ProposedOperation[] =>
  operations.filter((operation) => !isOperationAlreadyApplied(index, operation));

/**
 * The call sheets a shoot-day change invalidates.
 *
 * A published call sheet describes a day that no longer matches the plan, so it
 * must be regenerated rather than quietly left to mislead a crew.
 */
export const staleCallSheetIdsForShootDays = (
  index: ProductionIndex,
  shootDayIds: readonly string[],
): string[] => {
  const ids = new Set<string>();
  for (const shootDayId of shootDayIds) {
    for (const callSheet of callSheetsFor(index, shootDayId)) {
      ids.add(callSheet.id);
    }
  }
  return [...ids];
};
