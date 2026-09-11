import type { NextFunction, Request, Response } from "express";

/**
 * Response security headers (TASK-928, SEC-017 / AUD-024).
 *
 * The API answers JSON and nothing else, so its policy is the strictest one:
 * no content may load from an API response, it may not be framed, sniffed,
 * cached, or used as a referrer, and it belongs to its own origin only. A
 * deployment behind TLS also announces HSTS — only then, because an HSTS
 * header sent over plain HTTP is ignored at best and, on a shared host,
 * locks the whole host name to TLS at worst.
 *
 * The console's own policy (a CSP the Angular build can live under) is set
 * where the console is served: the dev server's `headers` in `angular.json`,
 * and the static host or proxy in a deployment (ARCHITECTURE.md §6).
 */

/** No content, no framing, no navigation: what a JSON endpoint needs. */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** A year, subdomains included; preload is the operator's decision. */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

export type SecurityHeaderOptions = {
  /** The service is reached over TLS (directly or behind a terminating proxy); adds HSTS. */
  readonly tlsTerminated?: boolean;
};

export const securityHeaders =
  (options: SecurityHeaderOptions = {}) =>
  (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // Every answer is about a production's current state or a person's own
    // session: never cache it, anywhere.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    if (options.tlsTerminated === true) {
      response.setHeader("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
    }
    next();
  };
