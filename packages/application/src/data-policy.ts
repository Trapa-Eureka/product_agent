import { createHash } from "node:crypto";

/**
 * Data policy at intake (TASK-922, SEC-011 / AUD-017).
 *
 * A change sentence is stored verbatim once, on the change request, so the
 * record of what the user said survives. It is not copied anywhere else:
 * the audit event that files the request carries a digest and a length, so
 * the trail can prove which sentence was submitted without holding a second
 * copy of it. And a sentence that plainly carries a credential is refused
 * before anything is persisted — a scheduling console has no use for a key,
 * and a stored one would outlive the mistake.
 *
 * The patterns are the high-confidence shapes only: a false refusal costs a
 * resubmit, a false acceptance stores a secret. Nothing here echoes the
 * match back; the caller learns the kind, never the value.
 */

export type CredentialKind =
  | "AWS access key"
  | "private key"
  | "GitHub token"
  | "Slack token"
  | "Google API key"
  | "JWT"
  | "access token";

const CREDENTIAL_PATTERNS: readonly { readonly kind: CredentialKind; readonly pattern: RegExp }[] =
  [
    { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
    { kind: "private key", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u },
    { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
    { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
    { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
    { kind: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u },
    /** This product's own tokens (TASK-914). */
    { kind: "access token", pattern: /\bpca1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u },
  ];

/** The kind of credential `text` appears to contain, or `null`. Never the value. */
export const findCredential = (text: string): CredentialKind | null =>
  CREDENTIAL_PATTERNS.find((entry) => entry.pattern.test(text))?.kind ?? null;

/** SHA-256 of the sentence, hex: enough to prove which sentence, useless to recover it. */
export const rawTextDigest = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
