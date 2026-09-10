import type { Clock, IdFactory, RepositorySet } from "@pca/application";

import type { ToolHandlers } from "../server";
import { createAnalysisToolHandlers } from "./analysis-tools";
import { createProposalToolHandlers } from "./proposal-tools";
import { createReadToolHandlers } from "./read-tools";
import { createVerifyToolHandlers } from "./verify-tools";
import { createWriteToolHandlers } from "./write-tools";

/**
 * Every tool in the registry, wired. The entry point and the registry-wide
 * contract suite both use this, so the suite tests the server that ships
 * rather than a hand-assembled subset of it.
 */
export const createAllToolHandlers = (dependencies: {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
}): ToolHandlers => ({
  ...createReadToolHandlers(dependencies),
  ...createAnalysisToolHandlers(dependencies),
  ...createProposalToolHandlers(dependencies),
  ...createWriteToolHandlers(dependencies),
  ...createVerifyToolHandlers(dependencies),
});
