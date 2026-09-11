import { z } from "zod";

import type { IdempotencyKey } from "./primitives";
import {
  entityIdSchema,
  idempotencyKeySchema,
  productionVersionSchema,
  proposalDigestSchema,
} from "./primitives";
import type { Proposal } from "./proposal";

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

/**
 * The deterministic apply key (INV-8, TASK-937): derived from the proposal
 * and its digest, so a client retry and a queue redelivery agree on identity,
 * and a re-apply of the same sealed proposal replays instead of applying
 * twice. It lives in contracts because every client derives it — the console
 * in the browser as well as the server — from the proposal the API returned.
 */
export const idempotencyKeyForProposal = (
  proposal: Pick<Proposal, "id" | "digest">,
): IdempotencyKey => `apply:${proposal.id}:${proposal.digest.slice(0, 16)}`;
