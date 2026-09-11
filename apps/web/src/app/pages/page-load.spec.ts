import { describe, expect, it } from "vitest";

import { latestOnly } from "./page-load";

describe("latestOnly", () => {
  it("lets only the newest request write, whatever order the answers arrive in", () => {
    const begin = latestOnly();
    const first = begin();
    expect(first()).toBe(true);
    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    const third = begin();
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });
});
