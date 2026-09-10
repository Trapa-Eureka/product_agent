import type {
  EntityId,
  LocalDate,
  RejectedScheduleDay,
  Scene,
  ScheduleCandidate,
  ShootDay,
} from "@pca/contracts";

import { isBlockedOn } from "./dates";
import type { ProductionIndex } from "./production-state";
import { callSheetsFor, scheduledShootDay } from "./production-state";

/**
 * Candidate shoot days (ARCHITECTURE.md §8, MCP.md §5).
 *
 * Given scenes that must move, list the existing shoot days on which every
 * one of them could shoot: all required cast free, the location free. That is
 * the whole rule. There is deliberately no scoring, no capacity model, no
 * splitting of the group across days, and no invention of new days. Those
 * would be the beginnings of a scheduling solver, which is a different product.
 *
 * A model may re-rank or explain the result. It cannot add to it: every
 * candidate returned here passed INV-1 and INV-2 for every moving scene, and
 * every refused day says exactly why.
 */

export type CandidateGenerationInput = {
  readonly sceneIds: readonly EntityId[];
  /** Dates the caller already knows are off the table. */
  readonly excludeDates?: readonly LocalDate[];
};

export type CandidateGeneration = {
  /** Valid days, earliest first. Ranking beyond date order is left to the caller. */
  readonly candidates: ScheduleCandidate[];
  readonly rejected: RejectedScheduleDay[];
};

const sceneLabel = (scene: Scene): string => `Scene ${scene.sceneNumber}`;

/** Why a day cannot host the group, or an empty list when it can. */
const reasonsAgainst = (
  index: ProductionIndex,
  day: ShootDay,
  scenes: readonly Scene[],
): string[] => {
  const reasons: string[] = [];

  for (const scene of scenes) {
    for (const castId of scene.requiredCastIds) {
      const cast = index.castById.get(castId);
      if (cast === undefined) {
        reasons.push(`${sceneLabel(scene)} requires cast ${castId}, which does not exist.`);
      } else if (isBlockedOn(cast.unavailable, day.date)) {
        reasons.push(
          `${cast.name} is unavailable on ${day.date} and is required by ${sceneLabel(scene)}.`,
        );
      }
    }

    const location = index.locationById.get(scene.locationId);
    if (location === undefined) {
      reasons.push(
        `${sceneLabel(scene)} references location ${scene.locationId}, which does not exist.`,
      );
    } else if (isBlockedOn(location.unavailable, day.date)) {
      reasons.push(
        `${location.name} is unavailable on ${day.date} and is needed by ${sceneLabel(scene)}.`,
      );
    }
  }

  return reasons;
};

/** What a coordinator should know about a valid day before choosing it. */
const warningsFor = (index: ProductionIndex, day: ShootDay, scenes: readonly Scene[]): string[] => {
  const warnings: string[] = [];
  const movingSceneIds = new Set(scenes.map((scene) => scene.id));
  const alreadyThere = day.sceneIds
    .filter((sceneId) => !movingSceneIds.has(sceneId))
    .map((sceneId) => index.sceneById.get(sceneId))
    .filter((scene): scene is Scene => scene !== undefined);

  const seenCast = new Set<EntityId>();
  for (const scene of scenes) {
    for (const castId of scene.requiredCastIds) {
      if (seenCast.has(castId)) {
        continue;
      }
      seenCast.add(castId);
      const cast = index.castById.get(castId);
      if (cast === undefined) {
        continue;
      }
      const bookings = alreadyThere.filter((other) => other.requiredCastIds.includes(castId));
      for (const other of bookings) {
        warnings.push(`${cast.name} is already required on ${day.date} for ${sceneLabel(other)}.`);
      }
    }
  }

  for (const callSheet of callSheetsFor(index, day.id)) {
    if (callSheet.status === "PUBLISHED") {
      warnings.push(`Call sheet ${callSheet.id} is published and would need regeneration.`);
    }
  }

  return warnings;
};

export const generateScheduleCandidates = (
  index: ProductionIndex,
  input: CandidateGenerationInput,
): CandidateGeneration => {
  const excluded = new Set(input.excludeDates ?? []);
  const scenes: Scene[] = [];
  const unknownSceneIds: EntityId[] = [];
  for (const sceneId of input.sceneIds) {
    const scene = index.sceneById.get(sceneId);
    if (scene === undefined) {
      unknownSceneIds.push(sceneId);
    } else {
      scenes.push(scene);
    }
  }

  /** Days any moving scene is already on: a move there changes nothing. */
  const currentDayIds = new Set(
    scenes
      .map((scene) => scheduledShootDay(index, scene.id)?.id)
      .filter((id): id is EntityId => id !== undefined),
  );

  const candidates: ScheduleCandidate[] = [];
  const rejected: RejectedScheduleDay[] = [];

  const days = [...index.state.shootDays].sort((left, right) =>
    left.date.localeCompare(right.date),
  );

  for (const day of days) {
    const reasons: string[] = [];
    if (excluded.has(day.date)) {
      reasons.push(`${day.date} was excluded by the request.`);
    }
    if (currentDayIds.has(day.id)) {
      reasons.push(`A moving scene is already scheduled on ${day.date}.`);
    }
    for (const sceneId of unknownSceneIds) {
      reasons.push(`Scene ${sceneId} does not exist in this production.`);
    }
    reasons.push(...reasonsAgainst(index, day, scenes));

    if (reasons.length > 0) {
      rejected.push({ shootDayId: day.id, date: day.date, reasons });
      continue;
    }

    candidates.push({
      shootDayId: day.id,
      date: day.date,
      sceneIds: scenes.map((scene) => scene.id),
      warnings: warningsFor(index, day, scenes),
    });
  }

  return { candidates, rejected };
};
