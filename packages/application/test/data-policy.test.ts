import { describe, expect, it } from "vitest";

import { findCredential, rawTextDigest } from "../src";

/** TASK-922 (SEC-011 / AUD-017): a sentence that plainly carries a credential is refused at intake. */
describe("data policy", () => {
  it.each([
    ["AWS access key", "Use AKIAIOSFODNN7EXAMPLE for the upload."],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
    ["GitHub token", `token ghp_${"a".repeat(36)} please`],
    ["Slack token", "xoxb-123456789012-abcdefghijkl"],
    ["Google API key", `key AIza${"B".repeat(35)}`],
    ["JWT", `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`],
    ["access token", `pca1.${"x".repeat(12)}.${"y".repeat(12)}`],
  ])("names a %s without echoing it", (kind, text) => {
    expect(findCredential(text)).toBe(kind);
  });

  it("lets ordinary production sentences through", () => {
    for (const text of [
      "Sarah cannot shoot Friday.",
      "The warehouse is unavailable Friday.",
      "Scene 18 now needs a red car.",
      "Move S07 and S12 to SD-2026-09-22; call sheet CS-2026-09-18 goes stale.",
      "Budget line AK-2026 is fine.",
    ]) {
      expect(findCredential(text)).toBeNull();
    }
  });

  it("digests a sentence stably and one-way", () => {
    expect(rawTextDigest("Sarah cannot shoot Friday.")).toMatch(/^[0-9a-f]{64}$/u);
    expect(rawTextDigest("Sarah cannot shoot Friday.")).toBe(
      rawTextDigest("Sarah cannot shoot Friday."),
    );
    expect(rawTextDigest("a")).not.toBe(rawTextDigest("b"));
  });
});
