import { z } from "zod";

import {
  approvalSchema,
  auditEventSchema,
  changeRequestSchema,
  entityIdSchema,
  idempotencyKeySchema,
  productionStateSchema,
  productionVersionSchema,
  proposalDigestSchema,
  proposalSchema,
} from "@pca/contracts";

/**
 * On-disk shape of the file store.
 *
 * The whole database is one JSON document, validated on every read. Reading a
 * corrupt or hand-edited file should fail here with the offending field named,
 * not three layers later as a missing scene.
 */

const idempotencyRecordSchema = z.strictObject({
  key: idempotencyKeySchema,
  productionId: entityIdSchema,
  proposalId: entityIdSchema,
  proposalDigest: proposalDigestSchema,
  productionVersionAfter: productionVersionSchema,
  affectedEntityIds: z.array(entityIdSchema),
});

/** Bumped only when the layout changes in a way an older file cannot satisfy. */
export const FILE_FORMAT_VERSION = 1;

export const fileDatabaseSchema = z.strictObject({
  formatVersion: z.literal(FILE_FORMAT_VERSION),
  productions: z.record(entityIdSchema, productionStateSchema),
  changeRequests: z.array(changeRequestSchema),
  proposals: z.array(proposalSchema),
  approvals: z.array(approvalSchema),
  auditEvents: z.array(auditEventSchema),
  idempotency: z.array(idempotencyRecordSchema),
});

export type FileDatabase = z.infer<typeof fileDatabaseSchema>;
export type StoredIdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

export const emptyDatabase = (): FileDatabase => ({
  formatVersion: FILE_FORMAT_VERSION,
  productions: {},
  changeRequests: [],
  proposals: [],
  approvals: [],
  auditEvents: [],
  idempotency: [],
});
