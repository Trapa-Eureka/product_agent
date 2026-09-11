import type { ToolError } from "@pca/contracts";

/**
 * What a read-only page knows about the request behind it (TASK-913, code
 * review #15). A page is loading, has its rows, or has the server's error;
 * there is no fourth state in which a promise was dropped and the spinner
 * stays forever.
 */
export type PageLoad<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "error"; readonly error: ToolError };

export const LOADING: PageLoad<never> = { kind: "loading" };

/**
 * Only the newest request may write. Each call to the returned function
 * starts a request and hands back `isCurrent`; a completion whose ticket is
 * no longer current — the page moved to another production meanwhile — is
 * ignored, so a slow answer about the previous production can never land
 * under the current header.
 */
export const latestOnly = (): (() => () => boolean) => {
  let current = 0;
  return () => {
    const ticket = (current += 1);
    return () => ticket === current;
  };
};
