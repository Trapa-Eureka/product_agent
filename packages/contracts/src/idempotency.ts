import { z } from "zod";

import {
  entityIdSchema,
  idempotencyKeySchema,
  productionVersionSchema,
  proposalDigestSchema,
} from "./primitives";

/**
 * The idempotency record as every store persists it (TASK-926): the key, the
 * production it is scoped to (INV-4), and what the first successful apply
 * produced, so a replay can answer without applying again. Both the file
 * store and Mongo validate rows against this on read and write.
 */
export const storedIdempotencyRecordSchema = z.strictObject({
  key: idempotencyKeySchema,
  productionId: entityIdSchema,
  proposalId: entityIdSchema,
  proposalDigest: proposalDigestSchema,
  productionVersionAfter: productionVersionSchema,
  affectedEntityIds: z.array(entityIdSchema),
});

export type StoredIdempotencyRecord = z.infer<typeof storedIdempotencyRecordSchema>;
