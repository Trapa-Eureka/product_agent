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
