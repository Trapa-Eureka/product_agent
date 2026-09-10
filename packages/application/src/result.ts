import type { ToolError, ToolErrorCode } from "@pca/contracts";

/**
 * The outcome of a use case.
 *
 * Expected failures such as an unknown entity or a stale version are values,
 * not exceptions: the caller must handle them, and an agent reading the error
 * needs the stable code and next step rather than a stack trace. Exceptions are
 * reserved for faults nobody planned for.
 */
export type UseCaseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolError };

export const succeed = <T>(value: T): UseCaseResult<T> => ({ ok: true, value });

export const fail = <T = never>(
  code: ToolErrorCode,
  message: string,
  details: {
    readonly correlationId?: string;
    readonly expected?: string;
    readonly actual?: string;
    readonly nextStep?: string;
  } = {},
): UseCaseResult<T> => ({
  ok: false,
  error: {
    code,
    message,
    ...(details.correlationId === undefined ? {} : { correlationId: details.correlationId }),
    ...(details.expected === undefined ? {} : { expected: details.expected }),
    ...(details.actual === undefined ? {} : { actual: details.actual }),
    ...(details.nextStep === undefined ? {} : { nextStep: details.nextStep }),
  },
});
