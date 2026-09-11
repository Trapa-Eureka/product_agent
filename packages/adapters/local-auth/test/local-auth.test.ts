import { describe, expect, it } from "vitest";

import type { Principal } from "@pca/contracts";
import { fixedClock } from "@pca/test-support";

import {
  MIN_SECRET_LENGTH,
  TOKEN_PREFIX,
  createLocalIdentity,
  generateAuthSecret,
  issueToken,
  verifyToken,
} from "../src";

const NOW = "2026-09-11T12:00:00.000Z";
const clock = fixedClock(NOW);
const secret = "s".repeat(MIN_SECRET_LENGTH);

const jane: Principal = {
  subject: "jane@example.test",
  issuer: "pca-local",
  type: "USER",
  roles: ["approver"],
  productions: ["PROD-DEMO"],
};

describe("local auth tokens (TASK-914)", () => {
  it("round-trips a principal through issue and verify", () => {
    const token = issueToken({ secret, principal: jane, clock });
    expect(token.startsWith(`${TOKEN_PREFIX}.`)).toBe(true);
    expect(verifyToken({ secret, clock }, token)).toEqual({ ok: true, principal: jane });
  });

  it("refuses a token signed with another secret", () => {
    const token = issueToken({ secret: "t".repeat(MIN_SECRET_LENGTH), principal: jane, clock });
    expect(verifyToken({ secret, clock }, token)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("refuses a token whose claims were edited after signing", () => {
    const token = issueToken({ secret, principal: jane, clock });
    const [prefix, payload, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Principal;
    const forged = Buffer.from(JSON.stringify({ ...claims, productions: "*" }), "utf8").toString(
      "base64url",
    );
    expect(verifyToken({ secret, clock }, `${prefix}.${forged}.${signature}`)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("refuses malformed tokens without inspecting them", () => {
    for (const bad of ["", "pca1", "pca1..", "jwt.x.y", `${TOKEN_PREFIX}.abc.`]) {
      expect(verifyToken({ secret, clock }, bad)).toEqual({ ok: false, reason: "MALFORMED" });
    }
  });

  it("refuses an expired token and honours one that has not expired", () => {
    const token = issueToken({ secret, principal: jane, clock, ttlSeconds: 60 });
    expect(verifyToken({ secret, clock }, token).ok).toBe(true);
    const later = fixedClock("2026-09-11T12:01:00.000Z");
    expect(verifyToken({ secret, clock: later }, token)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("refuses a token issued in the future", () => {
    const token = issueToken({
      secret,
      principal: jane,
      clock: fixedClock("2026-09-11T13:00:00.000Z"),
    });
    expect(verifyToken({ secret, clock }, token)).toEqual({ ok: false, reason: "NOT_YET_VALID" });
  });

  it("refuses to sign an invalid principal", () => {
    expect(() => issueToken({ secret, principal: { ...jane, roles: [] }, clock })).toThrow();
  });

  it("refuses a short secret at construction, and generates a long one", () => {
    expect(() => createLocalIdentity({ secret: "short", clock })).toThrow(/at least 32/u);
    expect(generateAuthSecret()).toHaveLength(64);
    expect(generateAuthSecret()).not.toBe(generateAuthSecret());
  });

  it("exposes verification as the application's identity port", async () => {
    const identity = createLocalIdentity({ secret, clock });
    const token = issueToken({ secret, principal: jane, clock });
    await expect(identity.verify(token)).resolves.toEqual({ ok: true, principal: jane });
    await expect(identity.verify("nope")).resolves.toEqual({ ok: false, reason: "MALFORMED" });
  });
});
