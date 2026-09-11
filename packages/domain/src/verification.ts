import type { ProposedOperation } from "@pca/contracts";
import { EXPLANATION_MAX_LENGTH, VERIFICATION_CHECK_NAME_MAX_LENGTH } from "@pca/contracts";

import { isBlockedOn, isRangeCovered } from "./dates";
import { checkStateInvariants } from "./invariants/state";
import type { ProductionIndex } from "./production-state";
import {
  requirementsFor,
  scenesAtLocation,
  scenesRequiringCast,
  scheduledShootDay,
  tasksFor,
} from "./production-state";
import { findEquivalentRequirement, normalizeRequirementName } from "./requirements";

/**
 * Post-write verification (SPEC.md FR-8, MCP.md §8).
 *
 * After a proposal is applied, re-read the production and ask, operation by
 * operation, whether its postcondition actually holds. This is not a re-run of
 * the simulation: simulation predicts, verification observes. A check that
 * passes here passed against the stored state, not against a copy.
 *
 * Each check is named so a failure says what is wrong in the coordinator's
 * words, and the whole list is returned rather than the first failure.
 *
 * Names are labels, not documents (TASK-912, code review #14). They quote
 * user-written text — a cast member's name, a task title — so a coordinator
 * recognises the operation, but such a fragment is cut to a few dozen
 * characters and the whole name to the MCP output contract's limit, so a
 * valid proposal can never produce a check the tool refuses to return. The
 * full text lives in `detail`, which has its own, larger, bound.
 */

export type VerificationCheck = {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
};

const ELLIPSIS = "\u2026";

/** `text`, or its first `max` characters with the cut marked. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;

/**
 * Room for one user-written fragment inside a check name. Sized so the
 * longest template with two fragments ("No scene requiring X remains
 * scheduled while X is unavailable") still fits the name limit whole.
 */
export const CHECK_NAME_FRAGMENT_MAX_LENGTH = 30;

const fragment = (text: string): string => clip(text, CHECK_NAME_FRAGMENT_MAX_LENGTH);

const check = (name: string, passed: boolean, detail: string): VerificationCheck => ({
  name: clip(name, VERIFICATION_CHECK_NAME_MAX_LENGTH),
  passed,
  detail: clip(detail, EXPLANATION_MAX_LENGTH),
});

const sceneLabel = (index: ProductionIndex, sceneId: string): string => {
  const scene = index.sceneById.get(sceneId);
  return scene === undefined ? `scene ${sceneId}` : `Scene ${scene.sceneNumber}`;
};

/** One check per operation: does the world now show what the operation promised? */
export const verifyOperationsApplied = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
): VerificationCheck[] =>
  operations.map((operation, position) => {
    const ordinal = `${position + 1}`;
    switch (operation.type) {
      case "RECORD_CAST_UNAVAILABILITY": {
        const cast = index.castById.get(operation.castId);
        const name = `${ordinal}. ${fragment(cast?.name ?? operation.castId)} recorded unavailable ${operation.unavailable.start} to ${operation.unavailable.end}`;
        if (cast === undefined) {
          return check(name, false, `Cast member ${operation.castId} does not exist.`);
        }
        const covered = isRangeCovered(cast.unavailable, operation.unavailable);
        return check(
          name,
          covered,
          covered
            ? `${cast.name}'s record blocks the window.`
            : `${cast.name}'s record does not block the whole window.`,
        );
      }

      case "RECORD_LOCATION_UNAVAILABILITY": {
        const location = index.locationById.get(operation.locationId);
        const name = `${ordinal}. ${fragment(location?.name ?? operation.locationId)} recorded unavailable ${operation.unavailable.start} to ${operation.unavailable.end}`;
        if (location === undefined) {
          return check(name, false, `Location ${operation.locationId} does not exist.`);
        }
        const covered = isRangeCovered(location.unavailable, operation.unavailable);
        return check(
          name,
          covered,
          covered
            ? `${location.name}'s record blocks the window.`
            : `${location.name}'s record does not block the whole window.`,
        );
      }

      case "MOVE_SCENES": {
        const target = index.shootDayById.get(operation.toShootDayId);
        const source = index.shootDayById.get(operation.fromShootDayId);
        const labels = operation.sceneIds.map((sceneId) => sceneLabel(index, sceneId)).join(", ");
        const name = `${ordinal}. ${labels} moved to ${target?.date ?? operation.toShootDayId}`;
        if (target === undefined) {
          return check(name, false, `Shoot day ${operation.toShootDayId} does not exist.`);
        }
        const misplaced = operation.sceneIds.filter((sceneId) => {
          const day = scheduledShootDay(index, sceneId);
          return (
            day?.id !== target.id || (source !== undefined && source.sceneIds.includes(sceneId))
          );
        });
        return check(
          name,
          misplaced.length === 0,
          misplaced.length === 0
            ? `Every scene sits on ${target.date} and none remains on ${source?.date ?? operation.fromShootDayId}.`
            : `${misplaced.map((sceneId) => sceneLabel(index, sceneId)).join(", ")} not on ${target.date}, or still on ${source?.date ?? operation.fromShootDayId}.`,
        );
      }

      case "ADD_SCENE_REQUIREMENT": {
        const scene = index.sceneById.get(operation.sceneId);
        const name = `${ordinal}. ${sceneLabel(index, operation.sceneId)} has ${operation.requirementType} "${fragment(operation.name)}"`;
        if (scene === undefined) {
          return check(name, false, `Scene ${operation.sceneId} does not exist.`);
        }
        const requirement = findEquivalentRequirement(requirementsFor(index, scene.id), {
          type: operation.requirementType,
          name: operation.name,
        });
        const wired = requirement !== null && scene.requirementIds.includes(requirement.id);
        return check(
          name,
          wired,
          requirement === null
            ? `No ${operation.requirementType} "${operation.name}" exists on the scene.`
            : wired
              ? `Requirement ${requirement.id} exists and is listed on the scene.`
              : `Requirement ${requirement.id} exists but the scene does not list it.`,
        );
      }

      case "CREATE_PREPARATION_TASK": {
        const name = `${ordinal}. Open task "${fragment(operation.title)}" exists`;
        const wanted = normalizeRequirementName(operation.title);
        const task = tasksFor(index, operation.relatedEntityType, operation.relatedEntityId).find(
          (candidate) =>
            candidate.status === "OPEN" && normalizeRequirementName(candidate.title) === wanted,
        );
        return check(
          name,
          task !== undefined,
          task === undefined
            ? `No open task titled "${operation.title}" is linked to ${operation.relatedEntityType} ${operation.relatedEntityId}.`
            : `Task ${task.id} "${operation.title}" is open and linked to ${operation.relatedEntityType} ${operation.relatedEntityId}.`,
        );
      }

      case "MARK_CALL_SHEET_STALE": {
        const callSheet = index.callSheetById.get(operation.callSheetId);
        const name = `${ordinal}. Call sheet ${operation.callSheetId} is a draft`;
        if (callSheet === undefined) {
          return check(name, false, `Call sheet ${operation.callSheetId} does not exist.`);
        }
        return check(
          name,
          callSheet.status === "DRAFT",
          callSheet.status === "DRAFT"
            ? "The call sheet is a draft awaiting regeneration."
            : `The call sheet is still ${callSheet.status}.`,
        );
      }
    }
  });

/**
 * The scenario-level promise: nobody unavailable is still scheduled. Scenario A
 * step 10 in SPEC.md asks for exactly this, in these words.
 */
export const verifyAvailabilityHonoured = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
): VerificationCheck[] => {
  const checks: VerificationCheck[] = [];

  for (const operation of operations) {
    if (operation.type === "RECORD_CAST_UNAVAILABILITY") {
      const cast = index.castById.get(operation.castId);
      if (cast === undefined) {
        continue;
      }
      const offending = scenesRequiringCast(index, cast.id).filter((scene) => {
        const day = scheduledShootDay(index, scene.id);
        return day !== null && isBlockedOn([operation.unavailable], day.date);
      });
      checks.push(
        check(
          `No scene requiring ${fragment(cast.name)} remains scheduled while ${fragment(cast.name)} is unavailable`,
          offending.length === 0,
          offending.length === 0
            ? `No scene requiring ${cast.name} falls inside ${operation.unavailable.start} to ${operation.unavailable.end}.`
            : `${offending.map((scene) => `Scene ${scene.sceneNumber}`).join(", ")} still scheduled inside the window.`,
        ),
      );
    }

    if (operation.type === "RECORD_LOCATION_UNAVAILABILITY") {
      const location = index.locationById.get(operation.locationId);
      if (location === undefined) {
        continue;
      }
      const offending = scenesAtLocation(index, location.id).filter((scene) => {
        const day = scheduledShootDay(index, scene.id);
        return day !== null && isBlockedOn([operation.unavailable], day.date);
      });
      checks.push(
        check(
          `No scene at ${fragment(location.name)} remains scheduled while ${fragment(location.name)} is unavailable`,
          offending.length === 0,
          offending.length === 0
            ? `No scene at ${location.name} falls inside ${operation.unavailable.start} to ${operation.unavailable.end}.`
            : `${offending.map((scene) => `Scene ${scene.sceneNumber}`).join(", ")} still scheduled inside the window.`,
        ),
      );
    }
  }

  return checks;
};

/** The production as a whole still satisfies INV-1 to INV-4. */
export const verifyInvariantsHold = (index: ProductionIndex): VerificationCheck => {
  const violations = checkStateInvariants(index);
  return check(
    "Production satisfies every invariant",
    violations.length === 0,
    violations.length === 0
      ? "No invariant violations."
      : violations
          .map((violation) => `${violation.invariant}: ${violation.conflict.detail}`)
          .join(" "),
  );
};
