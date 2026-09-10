import type { EntityId, TypedChange } from "@pca/contracts";
import type { ProductionIndex } from "@pca/domain";

/**
 * Every entity a typed change points at, with whether this production owns it.
 *
 * Shared by intake and analysis so both refuse the same hallucinated ID with
 * the same message and the same suggested lookup tool.
 */
export type ChangeReference = {
  readonly kind: "cast member" | "location" | "scene" | "shoot day";
  readonly id: EntityId;
  readonly exists: boolean;
  readonly lookupTool: string;
};

export const referencesOf = (index: ProductionIndex, change: TypedChange): ChangeReference[] => {
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return [
        {
          kind: "cast member",
          id: change.castId,
          exists: index.castById.has(change.castId),
          lookupTool: "find_cast",
        },
      ];
    case "LOCATION_UNAVAILABLE":
      return [
        {
          kind: "location",
          id: change.locationId,
          exists: index.locationById.has(change.locationId),
          lookupTool: "find_location",
        },
      ];
    case "SCENE_REQUIREMENT_CHANGED":
      return [
        {
          kind: "scene",
          id: change.sceneId,
          exists: index.sceneById.has(change.sceneId),
          lookupTool: "get_scene",
        },
      ];
    case "SCHEDULE_CHANGED":
      return [
        ...change.sceneIds.map((sceneId): ChangeReference => ({
          kind: "scene",
          id: sceneId,
          exists: index.sceneById.has(sceneId),
          lookupTool: "get_scene",
        })),
        {
          kind: "shoot day",
          id: change.toShootDayId,
          exists: index.shootDayById.has(change.toShootDayId),
          lookupTool: "get_schedule",
        },
      ];
  }
};

/** The first reference this production does not own, or null when all are known. */
export const firstMissingReference = (
  index: ProductionIndex,
  change: TypedChange,
): ChangeReference | null =>
  referencesOf(index, change).find((reference) => !reference.exists) ?? null;
