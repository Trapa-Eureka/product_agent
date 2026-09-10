import { describe, expect, it } from "vitest";

import { approvalSchema } from "../src/approval";
import { proposalSchema, proposedOperationSchema } from "../src/proposal";

const digest = "b".repeat(64);

const moveScenes = {
  type: "MOVE_SCENES",
  sceneIds: ["S07", "S12"],
  fromShootDayId: "SD-2026-09-18",
  toShootDayId: "SD-2026-09-21",
} as const;

describe("proposedOperationSchema", () => {
  it("accepts each MVP application command", () => {
    const operations = [
      moveScenes,
      { type: "ADD_SCENE_REQUIREMENT", sceneId: "S18", requirementType: "PROP", name: "red car" },
      {
        type: "CREATE_PREPARATION_TASK",
        title: "Source a red car for Scene 18",
        relatedEntityType: "SCENE",
        relatedEntityId: "S18",
      },
      { type: "MARK_CALL_SHEET_STALE", callSheetId: "CS-2026-09-18" },
    ];

    for (const operation of operations) {
      expect(proposedOperationSchema.safeParse(operation).success).toBe(true);
    }
  });

  it("rejects an operation type outside the allow-list", () => {
    expect(
      proposedOperationSchema.safeParse({ type: "DELETE_PRODUCTION", productionId: "PROD-DEMO" })
        .success,
    ).toBe(false);
  });

  it("rejects a raw database update disguised as an operation", () => {
    expect(
      proposedOperationSchema.safeParse({
        type: "MOVE_SCENES",
        sceneIds: ["S07"],
        fromShootDayId: "SD-2026-09-18",
        toShootDayId: "SD-2026-09-21",
        $set: { status: "CONFIRMED" },
      }).success,
    ).toBe(false);
  });

  it("rejects a move with no scenes", () => {
    expect(proposedOperationSchema.safeParse({ ...moveScenes, sceneIds: [] }).success).toBe(false);
  });
});

describe("proposalSchema", () => {
  const base = {
    id: "P-104",
    productionId: "PROD-DEMO",
    changeRequestId: "CR-001",
    baseProductionVersion: 12,
    operations: [moveScenes],
    impacts: [
      {
        entityType: "SCENE",
        entityId: "S07",
        reasonCode: "SCENE_REQUIRES_UNAVAILABLE_CAST",
        explanation: "Scene 07 requires Sarah and is scheduled Sep 18.",
        severity: "BLOCKING",
      },
    ],
    conflicts: [],
    warnings: ["Call sheet CS-2026-09-18 becomes stale."],
    validationStatus: "VALID",
    status: "AWAITING_APPROVAL",
    digest,
    summary: "Move Scene 07 and Scene 12 from Fri Sep 18 to Mon Sep 21.",
    createdAt: "2026-09-10T11:04:00.000Z",
  };

  it("accepts a simulated proposal awaiting approval", () => {
    expect(proposalSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a proposal with no operations, which would approve nothing", () => {
    expect(proposalSchema.safeParse({ ...base, operations: [] }).success).toBe(false);
  });

  it("rejects a proposal without the digest an approval must bind to", () => {
    const { digest: _omitted, ...withoutDigest } = base;
    expect(proposalSchema.safeParse(withoutDigest).success).toBe(false);
  });

  it("rejects a status outside the documented lifecycle", () => {
    expect(proposalSchema.safeParse({ ...base, status: "AUTO_APPLIED" }).success).toBe(false);
  });
});

describe("approvalSchema", () => {
  const base = {
    id: "A-77",
    proposalId: "P-104",
    proposalDigest: digest,
    productionVersion: 12,
    approvedBy: "coordinator@example.test",
    decision: "APPROVE",
    createdAt: "2026-09-10T11:05:00.000Z",
  };

  it("accepts an approval bound to a digest and a version", () => {
    expect(approvalSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a rejection", () => {
    expect(approvalSchema.safeParse({ ...base, decision: "REJECT" }).success).toBe(true);
  });

  it("rejects an approval that omits the proposal digest", () => {
    const { proposalDigest: _omitted, ...withoutDigest } = base;
    expect(approvalSchema.safeParse(withoutDigest).success).toBe(false);
  });

  it("rejects a decision the product does not offer, such as a conditional approval", () => {
    expect(approvalSchema.safeParse({ ...base, decision: "APPROVE_WITH_CHANGES" }).success).toBe(
      false,
    );
  });
});
