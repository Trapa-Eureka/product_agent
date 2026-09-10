import type { Clock, IdFactory, RepositorySet } from "@pca/application";
import { createApplyApprovedProposal } from "@pca/application";

import type { ToolHandlers } from "../server";

/**
 * The one consequential write (MCP.md §7).
 *
 * The handler adds nothing to the use case: the fixed order of checks
 * (idempotency, the INV-5/INV-6 gate, apply to a copy, atomic commit,
 * bookkeeping) lives in the application layer, where it is tested without a
 * transport. What the tool contributes is the acting identity from the server
 * context, recorded as who performed the apply, and the correlation ID.
 *
 * There is deliberately no approve tool. Approval is a human decision made in
 * the product, never something an agent can grant itself (SPEC.md §6).
 */
export const createWriteToolHandlers = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): ToolHandlers => {
  const apply = createApplyApprovedProposal(dependencies);

  return {
    apply_approved_proposal: (input, call) =>
      apply({ ...input, appliedBy: call.actor.id, correlationId: call.correlationId }),
  };
};
