import { z } from "zod";

import {
  entityIdSchema,
  isoDateTimeSchema,
  productionVersionSchema,
  proposalDigestSchema,
} from "./primitives";

/**
 * Approval contracts (SPEC.md §FR-6, DOMAIN.md INV-5/INV-6).
 *
 * An approval is bound to a digest and a production version, not merely to a
 * proposal ID. That binding is the whole safety story: it makes "approve, then
 * change the plan, then apply" impossible.
 */

export const approvalDecisionSchema = z.enum(["APPROVE", "REJECT"]);

export const approvalSchema = z.strictObject({
  id: entityIdSchema,
  /**
   * Present so every repository read can be scoped by production (INV-4).
   * Deriving tenancy by first loading the proposal would make the isolation
   * boundary depend on a join that a caller can forget.
   */
  productionId: entityIdSchema,
  proposalId: entityIdSchema,
  proposalDigest: proposalDigestSchema,
  productionVersion: productionVersionSchema,
  approvedBy: z.string().min(1).max(200),
  decision: approvalDecisionSchema,
  createdAt: isoDateTimeSchema,
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type Approval = z.infer<typeof approvalSchema>;
