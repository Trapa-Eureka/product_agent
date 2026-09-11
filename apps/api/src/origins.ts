/**
 * Browser Origin policy for the WebSocket upgrade (TASK-916, SEC-003 / AUD-007).
 *
 * Browsers open WebSockets cross-origin without a preflight, so a hostile
 * page can point one at a loopback API. The token (TASK-914) already keeps
 * an anonymous page out; this keeps a page that somehow holds a token — a
 * developer's own browser, most likely — from being driven by another site.
 *
 * Policy: an upgrade that carries an `Origin` must match the server's own
 * host (same-origin, so a UI the API serves itself always works) or an
 * origin the operator listed exactly in `PCA_ALLOWED_ORIGINS`. In demo mode
 * the Angular dev server's origins are allowed by default, because that is
 * where the demo UI runs. A connection with the token in the query string —
 * the browser path — must send an Origin; only a client that could set the
 * `Authorization` header, which no browser can, may omit it.
 */

/** Where `ng serve` runs the console (`playwright.config.ts`, README "Run the UI"). */
export const DEV_UI_ORIGINS: readonly string[] = ["http://localhost:4200", "http://127.0.0.1:4200"];

const ORIGINS_HELP =
  "List exact origins, comma-separated (PCA_ALLOWED_ORIGINS=https://console.example.com,http://localhost:4200); an origin is scheme, host, and port only.";

/** Parses a comma-separated list of exact origins; throws on anything that is not one. */
export const parseOrigins = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        throw new Error(`PCA_ALLOWED_ORIGINS entry "${entry}" is not a URL. ${ORIGINS_HELP}`);
      }
      if (parsed.origin !== entry) {
        throw new Error(
          `PCA_ALLOWED_ORIGINS entry "${entry}" is not an exact origin (expected "${parsed.origin}"). ${ORIGINS_HELP}`,
        );
      }
      return parsed.origin;
    });

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * `PCA_ALLOWED_ORIGINS` when set; otherwise the dev server's origins in demo
 * mode and nothing (same-origin only) in a deployment.
 */
export const allowedOriginsFromEnv = (
  env: Environment,
  mode: "token" | "demo",
): readonly string[] => {
  const raw = env["PCA_ALLOWED_ORIGINS"]?.trim();
  if (raw !== undefined && raw.length > 0) return parseOrigins(raw);
  return mode === "demo" ? DEV_UI_ORIGINS : [];
};

/** True when `origin` is the server's own host or on the operator's list. */
export const originAllowed = (input: {
  readonly origin: string;
  readonly host: string | undefined;
  readonly allowed: readonly string[];
}): boolean => {
  if (input.allowed.includes(input.origin)) return true;
  if (input.host === undefined) return false;
  try {
    // Host only: the scheme may differ at a TLS-terminating proxy, the host may not.
    return new URL(input.origin).host.toLowerCase() === input.host.toLowerCase();
  } catch {
    return false;
  }
};
