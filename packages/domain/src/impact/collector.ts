import type { Conflict, EntityId, EntityType, Impact, ImpactSeverity } from "@pca/contracts";

/**
 * Accumulates impacts and conflicts, then hands back a canonical ordering.
 *
 * Traversal order is an implementation detail; the order a coordinator reads
 * is not. Sorting by severity, then entity kind, then ID means the same
 * production and change always produce the same list, which is what lets a
 * golden test assert the exact array rather than "contains".
 */

const SEVERITY_RANK: Record<ImpactSeverity, number> = { BLOCKING: 0, WARNING: 1, INFO: 2 };

const ENTITY_RANK: Record<EntityType, number> = {
  SCENE: 0,
  CAST_MEMBER: 1,
  LOCATION: 2,
  REQUIREMENT: 3,
  SHOOT_DAY: 4,
  CALL_SHEET: 5,
  TASK: 6,
  PRODUCTION: 7,
};

export type ImpactAnalysis = {
  readonly impacts: Impact[];
  readonly conflicts: Conflict[];
  /** Every entity that carries at least one impact, sorted and unique. */
  readonly affectedEntityIds: EntityId[];
};

export class ImpactCollector {
  readonly #impacts = new Map<string, Impact>();
  readonly #conflicts: Conflict[] = [];

  /** The same finding about the same entity is recorded once. */
  add(impact: Impact): void {
    const key = `${impact.entityType}:${impact.entityId}:${impact.reasonCode}`;
    if (!this.#impacts.has(key)) {
      this.#impacts.set(key, impact);
    }
  }

  conflict(conflict: Conflict): void {
    this.#conflicts.push(conflict);
  }

  result(): ImpactAnalysis {
    const impacts = [...this.#impacts.values()].sort(
      (left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        ENTITY_RANK[left.entityType] - ENTITY_RANK[right.entityType] ||
        left.entityId.localeCompare(right.entityId) ||
        left.reasonCode.localeCompare(right.reasonCode),
    );

    const conflicts = [...this.#conflicts].sort(
      (left, right) =>
        ENTITY_RANK[left.entityType] - ENTITY_RANK[right.entityType] ||
        left.entityId.localeCompare(right.entityId) ||
        left.code.localeCompare(right.code),
    );

    const affectedEntityIds = [...new Set(impacts.map((impact) => impact.entityId))].sort(
      (left, right) => left.localeCompare(right),
    );

    return { impacts, conflicts, affectedEntityIds };
  }
}
