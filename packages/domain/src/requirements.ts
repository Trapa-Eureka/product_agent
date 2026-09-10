import type { Requirement, RequirementType } from "@pca/contracts";

/**
 * Requirement identity rules.
 *
 * SPEC.md §5-C asks the system to notice that a scene already needs a red car
 * before proposing to add one. Deciding that two names describe the same thing
 * is a domain rule, so it lives here rather than in a prompt: `Red Car`,
 * `red  car`, and `red car` are one requirement.
 */

export const normalizeRequirementName = (name: string): string =>
  name.trim().replace(/\s+/gu, " ").toLowerCase();

export const isSameRequirement = (
  left: Pick<Requirement, "type" | "name">,
  right: Pick<Requirement, "type" | "name">,
): boolean =>
  left.type === right.type &&
  normalizeRequirementName(left.name) === normalizeRequirementName(right.name);

/** The existing requirement equivalent to the candidate, if the scene already has one. */
export const findEquivalentRequirement = (
  existing: readonly Requirement[],
  candidate: { type: RequirementType; name: string },
): Requirement | null =>
  existing.find((requirement) => isSameRequirement(requirement, candidate)) ?? null;
