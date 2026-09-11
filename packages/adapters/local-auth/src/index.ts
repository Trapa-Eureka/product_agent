import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Clock, IdentityOutcome, IdentityPort } from "@pca/application";
import type { Principal } from "@pca/contracts";
import { principalSchema } from "@pca/contracts";

/**
 * Locally signed access tokens (TASK-914, SEC-001 / AUD-001).
 *
 * The free identity adapter: no identity provider, no account, no network.
 * A token is `pca1.<base64url claims>.<base64url HMAC-SHA256>`, signed with
 * a secret only the server and its operator hold. The operator mints tokens
 * (`pnpm run token -- --subject jane --role approver --production PROD-1`)
 * and hands them to people; the API verifies the signature and the expiry
 * on every request and derives the acting identity from the claims alone.
 *
 * Deliberately not a JWT library: there is one algorithm, no `alg` header to
 * downgrade, no key lookup, and the whole format fits on this page. An OIDC
 * verifier is a later adapter behind the same `IdentityPort`.
 */

export const TOKEN_PREFIX = "pca1";

/** A secret shorter than this is refused: it is the whole trust anchor. */
export const MIN_SECRET_LENGTH = 32;

const tokenClaimsSchema = principalSchema.extend({
  /** Issued at, seconds since the epoch. */
  iat: z.int().nonnegative(),
  /** Expires at, seconds since the epoch; a token without one never expires (operator tokens). */
  exp: z.int().positive().optional(),
});

export type TokenClaims = z.infer<typeof tokenClaimsSchema>;

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

const sign = (secret: string, payload: string): Buffer =>
  createHmac("sha256", secret).update(payload).digest();

const assertSecret = (secret: string): void => {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `The auth secret must be at least ${MIN_SECRET_LENGTH} characters; generate one with generateAuthSecret().`,
    );
  }
};

/** 32 random bytes as hex: the value to put in PCA_AUTH_SECRET. */
export const generateAuthSecret = (): string => randomBytes(32).toString("hex");

const secondsOf = (isoDateTime: string): number => Math.floor(Date.parse(isoDateTime) / 1000);

export type IssueTokenInput = {
  readonly secret: string;
  readonly principal: Principal;
  readonly clock: Clock;
  /** Seconds until expiry; omit for a token that never expires. */
  readonly ttlSeconds?: number;
};

/** Signs a token for `principal`. Throws on an invalid principal or a short secret. */
export const issueToken = (input: IssueTokenInput): string => {
  assertSecret(input.secret);
  const iat = secondsOf(input.clock.now());
  const claims: TokenClaims = {
    ...principalSchema.parse(input.principal),
    iat,
    ...(input.ttlSeconds === undefined ? {} : { exp: iat + input.ttlSeconds }),
  };
  const payload = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${TOKEN_PREFIX}.${payload}.${base64url(sign(input.secret, payload))}`;
};

export type VerifyTokenInput = {
  readonly secret: string;
  readonly clock: Clock;
};

/**
 * Verifies a token's shape, signature, and validity window. The signature
 * is compared in constant time and checked before the claims are parsed, so
 * a forged token learns nothing from a schema error message.
 */
export const verifyToken = (input: VerifyTokenInput, token: string): IdentityOutcome => {
  assertSecret(input.secret);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || parts[1] === "" || parts[2] === "") {
    return { ok: false, reason: "MALFORMED" };
  }
  const payload = parts[1] as string;
  const expected = sign(input.secret, payload);
  const given = Buffer.from(parts[2] as string, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const claims = tokenClaimsSchema.safeParse(json);
  if (!claims.success) {
    return { ok: false, reason: "MALFORMED" };
  }
  const now = secondsOf(input.clock.now());
  if (claims.data.iat > now + 60) {
    return { ok: false, reason: "NOT_YET_VALID" };
  }
  if (claims.data.exp !== undefined && claims.data.exp <= now) {
    return { ok: false, reason: "EXPIRED" };
  }
  const { iat: _iat, exp: _exp, ...principal } = claims.data;
  return { ok: true, principal };
};

export type LocalIdentityOptions = {
  readonly secret: string;
  readonly clock: Clock;
};

/** The identity port over locally signed tokens. */
export const createLocalIdentity = (options: LocalIdentityOptions): IdentityPort => {
  assertSecret(options.secret);
  return {
    verify: (credential) => Promise.resolve(verifyToken(options, credential)),
  };
};
