import type { EntityId } from "@pca/contracts";

/**
 * Production isolation (INV-4), enforced identically by every adapter.
 *
 * Writing this once means the JSON store, the in-memory store, and a future
 * Mongo adapter cannot disagree about what tenancy means or fail with three
 * different messages.
 */
export class ProductionIsolationError extends Error {
  constructor(
    readonly expectedProductionId: EntityId,
    readonly entityKind: string,
    readonly entityId: EntityId,
    readonly actualProductionId: EntityId,
  ) {
    super(
      `CROSS_PRODUCTION_REFERENCE: ${entityKind} ${entityId} belongs to production ` +
        `${actualProductionId} but was written to ${expectedProductionId}. ` +
        `Load and write entities through the production that owns them.`,
    );
    this.name = "ProductionIsolationError";
  }
}

/** Throws on the first record that belongs to another production. */
export const assertBelongsToProduction = (
  productionId: EntityId,
  entityKind: string,
  records: readonly { readonly id: EntityId; readonly productionId: EntityId }[] | undefined,
): void => {
  for (const record of records ?? []) {
    if (record.productionId !== productionId) {
      throw new ProductionIsolationError(productionId, entityKind, record.id, record.productionId);
    }
  }
};

/**
 * One unambiguous key for a record scoped to a production (TASK-907, code
 * review #8 / AUD-005). Adapters that index by a flat string — the memory
 * store's maps, Mongo's `_id` — used to concatenate `productionId::id`, and
 * entity IDs may contain colons, so `(A, B::P)` and `(A::B, P)` collided.
 * Each part now has its own colons escaped first (`%` before `:`, so the
 * escape itself cannot be forged), which makes the separator unambiguous.
 * `%` is outside the entity-ID alphabet, so an ID without a colon encodes to
 * exactly the string it always did: existing Mongo rows keep their `_id`.
 */
export const scopedRecordKey = (productionId: string, id: string): string =>
  scopedKeyOf(productionId, id);

/** The same encoding for any number of parts; `jobIdentityKey` uses three (TASK-935). */
export const scopedKeyOf = (...parts: readonly string[]): string =>
  parts.map(escapeKeyPart).join("::");

const escapeKeyPart = (part: string): string => part.replaceAll("%", "%25").replaceAll(":", "%3A");
