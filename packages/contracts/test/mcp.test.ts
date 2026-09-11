import { describe, expect, it } from "vitest";

import {
  MCP_TOOL_CONTRACTS,
  MCP_TOOL_NAMES,
  MCP_WRITE_TOOL_NAMES,
  VERIFICATION_CHECK_NAME_MAX_LENGTH,
  applyApprovedProposalInputSchema,
  getCastAvailabilityInputSchema,
  getSceneInputSchema,
  simulateProposalInputSchema,
  verifyAppliedProposalOutputSchema,
} from "../src/mcp";

describe("tool registry", () => {
  it("declares every tool documented in MCP.md", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      [
        "analyze_change_impact",
        "apply_approved_proposal",
        "create_proposal",
        "find_cast",
        "find_location",
        "generate_schedule_candidates",
        "get_call_sheet",
        "get_cast_availability",
        "get_location_availability",
        "get_production",
        "get_proposal",
        "get_scene",
        "get_schedule",
        "get_tasks",
        "simulate_proposal",
        "validate_proposal",
        "verify_applied_proposal",
      ].sort(),
    );
  });

  it("gives every tool both an input and an output schema", () => {
    for (const name of MCP_TOOL_NAMES) {
      const contract = MCP_TOOL_CONTRACTS[name];
      expect(contract.input, `${name} input`).toBeDefined();
      expect(contract.output, `${name} output`).toBeDefined();
    }
  });

  it("exposes exactly one consequential write tool", () => {
    expect(MCP_WRITE_TOOL_NAMES).toEqual(["apply_approved_proposal"]);
  });

  it("scopes every tool input to a production so ownership is checked server-side", () => {
    for (const name of MCP_TOOL_NAMES) {
      const result = MCP_TOOL_CONTRACTS[name].input.safeParse({});
      expect(result.success, `${name} accepted an empty input`).toBe(false);
    }
  });
});

describe("get_scene input", () => {
  it("accepts a lookup by scene number", () => {
    expect(
      getSceneInputSchema.safeParse({ productionId: "PROD-DEMO", sceneNumber: "18" }).success,
    ).toBe(true);
  });

  it("rejects a lookup that identifies no scene", () => {
    const result = getSceneInputSchema.safeParse({ productionId: "PROD-DEMO" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("sceneId or sceneNumber");
  });

  it("rejects an unknown key rather than silently ignoring it", () => {
    expect(
      getSceneInputSchema.safeParse({
        productionId: "PROD-DEMO",
        sceneNumber: "18",
        includeDrafts: true,
      }).success,
    ).toBe(false);
  });
});

describe("availability input", () => {
  it("accepts a single-day window", () => {
    expect(
      getCastAvailabilityInputSchema.safeParse({
        productionId: "PROD-DEMO",
        castId: "CAST-SARAH",
        from: "2026-09-18",
        to: "2026-09-18",
      }).success,
    ).toBe(true);
  });

  it("rejects a window that runs backwards", () => {
    expect(
      getCastAvailabilityInputSchema.safeParse({
        productionId: "PROD-DEMO",
        castId: "CAST-SARAH",
        from: "2026-09-21",
        to: "2026-09-18",
      }).success,
    ).toBe(false);
  });
});

describe("simulate_proposal input", () => {
  it("requires the base version the simulation was computed against", () => {
    expect(
      simulateProposalInputSchema.safeParse({
        productionId: "PROD-DEMO",
        operations: [
          {
            type: "MARK_CALL_SHEET_STALE",
            callSheetId: "CS-2026-09-18",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("verify_applied_proposal output", () => {
  const withName = (name: string) => ({ success: true, checks: [{ name, passed: true }] });

  it("accepts a check name at the documented limit and refuses one past it", () => {
    expect(
      verifyAppliedProposalOutputSchema.safeParse(
        withName("n".repeat(VERIFICATION_CHECK_NAME_MAX_LENGTH)),
      ).success,
    ).toBe(true);
    expect(
      verifyAppliedProposalOutputSchema.safeParse(
        withName("n".repeat(VERIFICATION_CHECK_NAME_MAX_LENGTH + 1)),
      ).success,
    ).toBe(false);
  });
});

describe("apply_approved_proposal input", () => {
  const base = {
    productionId: "PROD-DEMO",
    proposalId: "P-104",
    approvalId: "A-77",
    expectedProductionVersion: 12,
    idempotencyKey: "apply-P-104-v12",
  };

  it("accepts a fully bound apply request", () => {
    expect(applyApprovedProposalInputSchema.safeParse(base).success).toBe(true);
  });

  it.each(["approvalId", "expectedProductionVersion", "idempotencyKey"] as const)(
    "refuses to apply without %s",
    (field) => {
      const { [field]: _omitted, ...withoutField } = base;
      expect(applyApprovedProposalInputSchema.safeParse(withoutField).success).toBe(false);
    },
  );

  it("refuses an apply that tries to smuggle in its own operations", () => {
    expect(
      applyApprovedProposalInputSchema.safeParse({
        ...base,
        operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: "CS-2026-09-18" }],
      }).success,
    ).toBe(false);
  });
});
