import type { Principal } from "@pca/contracts";

/**
 * Identity port (TASK-914, ARCHITECTURE.md §15).
 *
 * The one way a delivery adapter turns a credential into a principal. The
 * application never sees the credential format — a locally signed token, an
 * OIDC assertion, a session — only the verified result. A refusal names why
 * so the boundary can answer 401 with a next step; it never echoes the
 * credential.
 */

export type IdentityRefusal = "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "NOT_YET_VALID";

export type IdentityOutcome =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: IdentityRefusal };

export type IdentityPort = {
  readonly verify: (credential: string) => Promise<IdentityOutcome>;
};

/**
 * The verified party recording a decision (`decideProposal`). Deliberately
 * not the whole principal: a decision needs who, who vouched, and what
 * roles — not the production grant, which the delivery layer already
 * checked against the route.
 */
export type Approver = Pick<Principal, "subject" | "issuer" | "roles">;
