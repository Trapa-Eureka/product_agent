import type { DateRange, EntityId } from "@pca/contracts";

/**
 * Scenario setup helpers for tests.
 *
 * These change availability data on a copy of a production snapshot. They hold
 * no domain rules: introducing a conflict is test setup, while deciding what
 * that conflict affects belongs to `@pca/domain`.
 */

type WithAvailability = {
  readonly id: EntityId;
  readonly unavailable: readonly DateRange[];
};

/** The same shape after cloning, where mutation is safe because nobody else holds it. */
type MutableAvailability = { id: EntityId; unavailable: DateRange[] };

type ProductionLike = {
  readonly castMembers: readonly WithAvailability[];
  readonly locations: readonly WithAvailability[];
};

/** A structural deep copy, so a mutated scenario cannot leak into another test. */
export const deepCopy = <T>(value: T): T => structuredClone(value);

const withUnavailability = <TState extends ProductionLike>(
  state: TState,
  collection: "castMembers" | "locations",
  entityId: EntityId,
  window: DateRange,
): TState => {
  const copy = deepCopy(state);
  // The clone is ours alone, so mutating it cannot surprise the caller. The cast
  // says exactly that and is the only place readonly is set aside.
  const entities = (copy as unknown as Record<"castMembers" | "locations", MutableAvailability[]>)[
    collection
  ];
  const target = entities.find((entity) => entity.id === entityId);

  if (target === undefined) {
    throw new Error(
      `Cannot block ${entityId}: no such entry in ${collection}. Check the fixture IDs.`,
    );
  }

  target.unavailable = [...target.unavailable, window];
  return copy;
};

/** Returns a copy in which the cast member is unavailable for the window. */
export const withCastUnavailable = <TState extends ProductionLike>(
  state: TState,
  castId: EntityId,
  window: DateRange,
): TState => withUnavailability(state, "castMembers", castId, window);

/** Returns a copy in which the location is unavailable for the window. */
export const withLocationUnavailable = <TState extends ProductionLike>(
  state: TState,
  locationId: EntityId,
  window: DateRange,
): TState => withUnavailability(state, "locations", locationId, window);

/** A single-day window, which is how most production conflicts are reported. */
export const onDay = (date: string): DateRange => ({ start: date, end: date });
