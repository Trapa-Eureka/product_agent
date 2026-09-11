import type { Approver } from "@pca/application";
import type { Principal } from "@pca/contracts";

/**
 * Verified-identity builders for tests (TASK-914). A use case takes a
 * principal, never a name, so tests say who is acting the same way the API
 * does after it has checked a token.
 */
export const approver = (subject: string, overrides: Partial<Approver> = {}): Approver => ({
  subject,
  issuer: "test",
  roles: ["approver"],
  ...overrides,
});

export const principal = (subject: string, overrides: Partial<Principal> = {}): Principal => ({
  subject,
  issuer: "test",
  type: "USER",
  roles: ["approver"],
  productions: "*",
  ...overrides,
});
