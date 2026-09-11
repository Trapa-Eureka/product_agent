import type { NextFunction, Request, Response } from "express";

import type { ToolError } from "@pca/contracts";

import { sendError } from "./errors";

/**
 * In-process request quotas (TASK-917, SEC-007 / AUD-008).
 *
 * A fixed window per key, held in memory: no broker, no external service,
 * which is what the free stack allows, and enough to stop one client from
 * monopolising a single-process server. Two quotas are applied: every
 * request, keyed by the client's address; and writes under a production —
 * the analysis, simulation, proposal, decision, and apply routes that cost
 * model and engine work — keyed by the verified principal, so a quota is
 * charged to who is asking rather than to where they come from.
 *
 * The address is the socket's own; a forwarded-for header is not trusted
 * until a proxy topology is configured (TASK-930).
 */

export type RateLimitRule = {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowMs: number;
};

export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type RateLimiter = {
  hit(key: string): RateLimitDecision;
  /** Keys currently tracked; bounded by the sweep below. */
  size(): number;
  /** Refusals since the process started (TASK-931 readiness). */
  rejected(): number;
};

type Window = { startedAt: number; count: number };

/** Tracked keys above which stale windows are swept on the next hit. */
const SWEEP_ABOVE = 10_000;

export const createRateLimiter = (
  rule: RateLimitRule,
  now: () => number = () => Date.now(),
): RateLimiter => {
  const windows = new Map<string, Window>();
  let rejections = 0;

  const sweep = (at: number): void => {
    for (const [key, window] of windows) {
      if (at - window.startedAt >= rule.windowMs) windows.delete(key);
    }
  };

  return {
    hit(key) {
      const at = now();
      if (windows.size > SWEEP_ABOVE) sweep(at);
      const window = windows.get(key);
      if (window === undefined || at - window.startedAt >= rule.windowMs) {
        windows.set(key, { startedAt: at, count: 1 });
        return { allowed: true, remaining: rule.limit - 1 };
      }
      if (window.count >= rule.limit) {
        rejections += 1;
        const retryAfterMs = window.startedAt + rule.windowMs - at;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      window.count += 1;
      return { allowed: true, remaining: rule.limit - window.count };
    },
    size: () => windows.size,
    rejected: () => rejections,
  };
};

export const rateLimited = (limit: number, retryAfterSeconds: number, what: string): ToolError => ({
  code: "RATE_LIMITED",
  message: `Too many ${what}: at most ${limit} per minute.`,
  nextStep: `Wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} (the Retry-After header) and try again.`,
});

/** Express middleware: refuse with 429 and `Retry-After` once `keyOf`'s key is over its quota. */
export const rateLimit =
  (
    limiter: RateLimiter,
    rule: RateLimitRule,
    keyOf: (request: Request, response: Response) => string,
    what: string,
  ) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const decision = limiter.hit(keyOf(request, response));
    if (decision.allowed) {
      next();
      return;
    }
    response.setHeader("Retry-After", String(decision.retryAfterSeconds));
    sendError(
      response,
      rateLimited(rule.limit, decision.retryAfterSeconds, what),
      response.locals["correlationId"] as string,
    );
  };

/** The socket's own address; `unknown` when the socket has none (a closed test socket, say). */
export const clientAddressOf = (request: Request): string =>
  request.socket.remoteAddress ?? "unknown";
