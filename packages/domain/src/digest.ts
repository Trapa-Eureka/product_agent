import { createHash } from "node:crypto";

import type { EntityId, ProductionVersion, ProposedOperation } from "@pca/contracts";

/**
 * Proposal digests (DOMAIN.md INV-6).
 *
 * The digest covers what an approver actually authorises: the production, the
 * change being answered, the base version, and the ordered operations. It
 * deliberately excludes impacts, warnings, and prose, because re-wording an
 * explanation must not invalidate a valid approval, while changing a single
 * operation must.
 *
 * `node:crypto` is a platform builtin, not infrastructure: no HTTP server,
 * database driver, cloud SDK, or model SDK enters the domain here.
 */

export type DigestInput = {
  readonly productionId: EntityId;
  readonly changeRequestId: EntityId;
  readonly baseProductionVersion: ProductionVersion;
  readonly operations: readonly ProposedOperation[];
};

/**
 * JSON with object keys sorted and no incidental whitespace.
 *
 * Array order is preserved: the order of operations is part of the plan, so
 * two proposals that apply the same operations in a different order are not the
 * same proposal.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(",")}}`;
};

export const canonicalProposalPayload = (input: DigestInput): string =>
  canonicalJson({
    productionId: input.productionId,
    changeRequestId: input.changeRequestId,
    baseProductionVersion: input.baseProductionVersion,
    operations: input.operations,
  });

export const computeProposalDigest = (input: DigestInput): string =>
  createHash("sha256").update(canonicalProposalPayload(input), "utf8").digest("hex");
