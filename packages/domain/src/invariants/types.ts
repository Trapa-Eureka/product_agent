import type { Conflict, ToolError, ToolErrorCode } from "@pca/contracts";

/** The invariants defined in DOMAIN.md §4. */
export type InvariantCode =
  "INV-1" | "INV-2" | "INV-3" | "INV-4" | "INV-5" | "INV-6" | "INV-7" | "INV-8";

/**
 * A state invariant that a production snapshot fails.
 *
 * The conflict is machine-readable so the UI, the explanation layer, and the
 * validator all describe the same finding rather than three paraphrases of it.
 */
export type InvariantViolation = {
  readonly invariant: InvariantCode;
  readonly conflict: Conflict;
};

/**
 * The outcome of a guard on the approval and apply path.
 *
 * Guards answer "may this proceed?", so a failure carries an actionable error
 * rather than a conflict: a stable code, what was expected, what was found, and
 * the next safe step (WORKFLOW.md §10).
 */
export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly invariant: InvariantCode; readonly error: ToolError };

export const guardPassed = (): GuardResult => ({ ok: true });

export const guardFailed = (
  invariant: InvariantCode,
  code: ToolErrorCode,
  message: string,
  details?: { expected?: string; actual?: string; nextStep?: string },
): GuardResult => ({
  ok: false,
  invariant,
  error: {
    code,
    message,
    ...(details?.expected === undefined ? {} : { expected: details.expected }),
    ...(details?.actual === undefined ? {} : { actual: details.actual }),
    ...(details?.nextStep === undefined ? {} : { nextStep: details.nextStep }),
  },
});

/** Returns the first failure, so a caller reports one actionable problem at a time. */
export const firstFailure = (results: readonly GuardResult[]): GuardResult =>
  results.find((result) => !result.ok) ?? guardPassed();
