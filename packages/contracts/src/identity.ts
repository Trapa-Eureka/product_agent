import { z } from "zod";

import { actorTypeSchema } from "./audit";
import { actorIdSchema, entityIdSchema } from "./primitives";

/**
 * Identity contracts (TASK-914, SEC-001 / AUD-001).
 *
 * A principal is what a verified credential says about its bearer: who they
 * are, who vouched for them, what they may do, and where. It is produced only
 * by an identity adapter that has checked a signature — never from a header a
 * caller fills in — and it is the sole source of the `approvedBy` /
 * `actorId` written into approvals and the audit trail.
 *
 * Roles are ordered: an approver may do everything a requester may, and a
 * requester everything a viewer may. `principalHasRole` is the one place that
 * order is encoded.
 */

export const principalRoleSchema = z.enum(["viewer", "requester", "approver"]);

export const principalSchema = z.strictObject({
  /** The verified subject; the value every approval and audit event records. */
  subject: actorIdSchema,
  /** Who issued the credential (`pca-local`, `pca-demo`, an OIDC issuer URL later). */
  issuer: z.string().min(1).max(200),
  type: actorTypeSchema,
  roles: z.array(principalRoleSchema).min(1).max(3),
  /** Productions the credential grants; `"*"` only for local demos. */
  productions: z.union([z.literal("*"), z.array(entityIdSchema).max(100)]),
});

export type PrincipalRole = z.infer<typeof principalRoleSchema>;
export type Principal = z.infer<typeof principalSchema>;

const ROLE_RANK: Readonly<Record<PrincipalRole, number>> = {
  viewer: 1,
  requester: 2,
  approver: 3,
};

/** True when any of the principal's roles is `role` or outranks it. */
export const principalHasRole = (
  principal: Pick<Principal, "roles">,
  role: PrincipalRole,
): boolean => principal.roles.some((held) => ROLE_RANK[held] >= ROLE_RANK[role]);

/** True when the credential names the production, or names every production. */
export const principalMayAccess = (
  principal: Pick<Principal, "productions">,
  productionId: string,
): boolean => principal.productions === "*" || principal.productions.includes(productionId);
