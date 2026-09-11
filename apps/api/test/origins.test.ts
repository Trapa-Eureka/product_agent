import { describe, expect, it } from "vitest";

import { DEV_UI_ORIGINS, allowedOriginsFromEnv, originAllowed, parseOrigins } from "../src/origins";

describe("origin policy (TASK-916)", () => {
  it("parses exact origins and refuses anything looser", () => {
    expect(parseOrigins(" https://console.example.com , http://localhost:4200 ,, ")).toEqual([
      "https://console.example.com",
      "http://localhost:4200",
    ]);
    expect(() => parseOrigins("https://console.example.com/app")).toThrow(/not an exact origin/u);
    expect(() => parseOrigins("console.example.com")).toThrow(/not a URL/u);
    expect(() => parseOrigins("https://Console.Example.com")).toThrow(/not an exact origin/u);
  });

  it("defaults to the dev server's origins in demo mode and to nothing in a deployment", () => {
    expect(allowedOriginsFromEnv({}, "demo")).toEqual(DEV_UI_ORIGINS);
    expect(allowedOriginsFromEnv({}, "token")).toEqual([]);
    expect(allowedOriginsFromEnv({ PCA_ALLOWED_ORIGINS: "https://a.example" }, "demo")).toEqual([
      "https://a.example",
    ]);
  });

  it("allows the server's own host and listed origins, nothing else", () => {
    const allowed = ["https://console.example.com"];
    expect(
      originAllowed({ origin: "https://console.example.com", host: "api:3000", allowed }),
    ).toBe(true);
    expect(
      originAllowed({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", allowed }),
    ).toBe(true);
    expect(originAllowed({ origin: "https://api.example", host: "API.EXAMPLE", allowed })).toBe(
      true,
    );
    expect(originAllowed({ origin: "http://evil.example", host: "127.0.0.1:3000", allowed })).toBe(
      false,
    );
    expect(
      originAllowed({ origin: "http://127.0.0.1:3001", host: "127.0.0.1:3000", allowed }),
    ).toBe(false);
    expect(originAllowed({ origin: "null", host: "127.0.0.1:3000", allowed })).toBe(false);
    expect(originAllowed({ origin: "http://127.0.0.1:3000", host: undefined, allowed })).toBe(
      false,
    );
  });
});
