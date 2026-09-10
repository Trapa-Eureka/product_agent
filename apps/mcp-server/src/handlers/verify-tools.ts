import type { Clock, IdFactory, RepositorySet } from "@pca/application";
import { createVerifyAppliedProposal, succeed } from "@pca/application";

import type { ToolHandlers } from "../server";

/**
 * Verification tool (MCP.md §8).
 *
 * A thin adapter over the verification use case. The use case also returns
 * the proposal it verified; the tool returns only `success` and the named
 * `checks`, because that is the contract and the strict output schema would
 * refuse the extra field. Verifying a proposal that was never applied is not
 * an error: it reports honestly that nothing holds.
 */
export const createVerifyToolHandlers = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): ToolHandlers => {
  const verify = createVerifyAppliedProposal(dependencies);

  return {
    verify_applied_proposal: async (input, call) => {
      const result = await verify({ ...input, correlationId: call.correlationId });
      if (!result.ok) return result;
      const checks = result.value.checks.map((check) => ({
        name: check.name,
        passed: check.passed,
        ...(check.detail === undefined ? {} : { detail: check.detail }),
      }));
      return succeed({ success: result.value.success, checks });
    },
  };
};
