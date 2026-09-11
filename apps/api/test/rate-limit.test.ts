import { describe, expect, it } from "vitest";

import { createRateLimiter } from "../src/rate-limit";

describe("rate limiter (TASK-917)", () => {
  it("allows up to the limit per window, then refuses with a retry delay until the window turns", () => {
    let at = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 }, () => at);
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 1 });
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 0 });
    at = 15_000;
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 45 });
    // Another key has its own window.
    expect(limiter.hit("b")).toEqual({ allowed: true, remaining: 1 });
    at = 60_000;
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 1 });
  });

  it("never reports a zero retry delay", () => {
    let at = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, () => at);
    limiter.hit("a");
    at = 999;
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("sweeps stale windows so tracked keys stay bounded", () => {
    let at = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, () => at);
    for (let index = 0; index <= 10_001; index += 1) limiter.hit(`k${index}`);
    expect(limiter.size()).toBe(10_002);
    at = 5000;
    limiter.hit("fresh");
    expect(limiter.size()).toBe(1);
  });
});
