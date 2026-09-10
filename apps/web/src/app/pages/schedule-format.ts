import type { EntityId, McpToolOutput, ShootDay, ShootDayStatus } from "@pca/contracts";

import { formatLocalDate } from "../workspace/typed-change-format";

/**
 * The Schedule nav view (DESIGN.md §2, TASK-507): "show before/after state
 * clearly." `get_schedule` returns each shoot day's raw `sceneIds`; a scene
 * ID is opaque (CLAUDE.md — never assume it encodes anything), so this page
 * also resolves each one through `get_scene` before it means anything to an
 * operator. The "before" and "after" are the same page revisited: it always
 * renders the schedule the server currently has, so approving a change and
 * coming back here is the before/after comparison — there is no separate
 * diff endpoint to keep in sync with production state that may have moved
 * on again since.
 *
 * Pure function of the two REST responses, so it is unit-tested without
 * Angular; the component only calls it and lays out the result.
 */

export type NormalizedScene = McpToolOutput<"get_scene">;

export type ScheduleSceneRow = {
  readonly sceneId: EntityId;
  readonly label: string;
  readonly locationName: string | null;
  readonly castNames: readonly string[];
};

export type ScheduleDayRow = {
  readonly shootDayId: EntityId;
  readonly date: string;
  readonly status: ShootDayStatus;
  readonly scenes: readonly ScheduleSceneRow[];
};

const sceneRow = (
  sceneId: EntityId,
  scenes: ReadonlyMap<EntityId, NormalizedScene>,
): ScheduleSceneRow => {
  const normalized = scenes.get(sceneId);
  if (normalized === undefined) {
    // A scene the caller has not resolved yet: shown honestly by its ID
    // rather than blocking the rest of the day's row.
    return { sceneId, label: `Scene ${sceneId}`, locationName: null, castNames: [] };
  }
  const { scene, location, requiredCast } = normalized;
  const label =
    scene.title === undefined
      ? `Scene ${scene.sceneNumber}`
      : `Scene ${scene.sceneNumber} — ${scene.title}`;
  return {
    sceneId,
    label,
    locationName: location.name,
    castNames: requiredCast.map((cast) => cast.name),
  };
};

export const buildScheduleRows = (
  shootDays: readonly ShootDay[],
  scenes: ReadonlyMap<EntityId, NormalizedScene>,
): ScheduleDayRow[] =>
  [...shootDays]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      shootDayId: day.id,
      date: formatLocalDate(day.date),
      status: day.status,
      scenes: day.sceneIds.map((sceneId) => sceneRow(sceneId, scenes)),
    }));
