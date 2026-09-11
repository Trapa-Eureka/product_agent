import { describe, expect, it } from "vitest";

import { scopedRecordKey } from "../src";

/**
 * TASK-907 (code review #8 / AUD-005): the one key encoding every flat-keyed
 * adapter uses for a production-scoped record.
 */
describe("scopedRecordKey", () => {
  it("encodes an ID without a colon exactly as adapters always did, so stored rows keep their key", () => {
    expect(scopedRecordKey("PROD-DEMO", "P-104")).toBe("PROD-DEMO::P-104");
    expect(scopedRecordKey("PROD-DEMO", "SD-2026-09-18")).toBe("PROD-DEMO::SD-2026-09-18");
  });

  it("keeps (A, B::P) and (A::B, P) apart", () => {
    expect(scopedRecordKey("A", "B::P")).not.toBe(scopedRecordKey("A::B", "P"));
    expect(scopedRecordKey("A", "B::P")).toBe("A::B%3A%3AP");
    expect(scopedRecordKey("A::B", "P")).toBe("A%3A%3AB::P");
  });

  it("escapes the escape character first, so an ID cannot forge an encoded colon", () => {
    expect(scopedRecordKey("A", "B%3AC")).toBe("A::B%253AC");
    expect(scopedRecordKey("A", "B%3AC")).not.toBe(scopedRecordKey("A", "B:C"));
  });
});
