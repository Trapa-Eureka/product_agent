import { describe, expect, it } from "vitest";

import {
  auditEventSchema,
  callSheetSchema,
  castMemberSchema,
  productionSchema,
  requirementSchema,
  sceneSchema,
  shootDaySchema,
  taskSchema,
} from "../src";

describe("entity schemas", () => {
  it("accepts the Demo Movie production", () => {
    expect(
      productionSchema.safeParse({
        id: "PROD-DEMO",
        name: "Demo Movie",
        timezone: "Asia/Manila",
        version: 0,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("accepts a scene with no cast, such as an establishing shot", () => {
    expect(
      sceneSchema.safeParse({
        id: "S18",
        productionId: "PROD-DEMO",
        sceneNumber: "18",
        locationId: "LOC-CAFE",
        requiredCastIds: [],
        requirementIds: [],
        estimatedMinutes: 45,
      }).success,
    ).toBe(true);
  });

  it("rejects a scene scheduled for zero minutes", () => {
    expect(
      sceneSchema.safeParse({
        id: "S18",
        productionId: "PROD-DEMO",
        sceneNumber: "18",
        locationId: "LOC-CAFE",
        requiredCastIds: [],
        requirementIds: [],
        estimatedMinutes: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts a cast member with an unavailability window", () => {
    expect(
      castMemberSchema.safeParse({
        id: "CAST-SARAH",
        productionId: "PROD-DEMO",
        name: "Sarah",
        roleName: "Lead",
        unavailable: [{ start: "2026-09-18", end: "2026-09-18" }],
      }).success,
    ).toBe(true);
  });

  it("rejects a requirement type the product does not model", () => {
    expect(
      requirementSchema.safeParse({
        id: "REQ-1",
        productionId: "PROD-DEMO",
        sceneId: "S18",
        type: "CATERING",
        name: "red car",
        status: "NEEDED",
      }).success,
    ).toBe(false);
  });

  it("accepts an empty shoot day, which is a valid reschedule target", () => {
    expect(
      shootDaySchema.safeParse({
        id: "SD-2026-09-22",
        productionId: "PROD-DEMO",
        date: "2026-09-22",
        sceneIds: [],
        status: "DRAFT",
      }).success,
    ).toBe(true);
  });

  it("rejects a call sheet version below one", () => {
    expect(
      callSheetSchema.safeParse({
        id: "CS-2026-09-18",
        productionId: "PROD-DEMO",
        shootDayId: "SD-2026-09-18",
        version: 0,
        status: "DRAFT",
      }).success,
    ).toBe(false);
  });

  it("rejects a task attached to an entity kind tasks cannot reference", () => {
    expect(
      taskSchema.safeParse({
        id: "T-1",
        productionId: "PROD-DEMO",
        title: "Source a red car",
        relatedEntityType: "CAST_MEMBER",
        relatedEntityId: "CAST-SARAH",
        status: "OPEN",
      }).success,
    ).toBe(false);
  });

  it("accepts an audit event with structured metadata", () => {
    expect(
      auditEventSchema.safeParse({
        id: "AE-1",
        productionId: "PROD-DEMO",
        actorType: "AGENT",
        action: "PROPOSAL_CREATED",
        entityType: "SCENE",
        entityId: "S07",
        correlationId: "corr-001",
        metadata: { proposalId: "P-104", operationCount: 4 },
        createdAt: "2026-09-10T11:04:00.000Z",
      }).success,
    ).toBe(true);
  });
});
