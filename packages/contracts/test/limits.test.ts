import { describe, expect, it } from "vitest";

import { scheduleChangedChangeSchema } from "../src/change";
import {
  createProposalInputSchema,
  generateScheduleCandidatesInputSchema,
  simulateProposalInputSchema,
} from "../src/mcp";
import { INPUT_LIMITS } from "../src/primitives";
import { moveScenesOperationSchema } from "../src/proposal";

/** TASK-917 (SEC-007 / AUD-008): every externally supplied array has a ceiling. */
describe("input cardinality limits", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `S${index + 1}`);
  const move = (count: number) => ({
    type: "MOVE_SCENES",
    sceneIds: ids(count),
    fromShootDayId: "SD-1",
    toShootDayId: "SD-2",
  });

  it("caps scene IDs per operation and per change", () => {
    expect(
      moveScenesOperationSchema.safeParse(move(INPUT_LIMITS.sceneIdsPerOperation)).success,
    ).toBe(true);
    expect(
      moveScenesOperationSchema.safeParse(move(INPUT_LIMITS.sceneIdsPerOperation + 1)).success,
    ).toBe(false);
    expect(
      scheduleChangedChangeSchema.safeParse({
        type: "SCHEDULE_CHANGED",
        sceneIds: ids(INPUT_LIMITS.sceneIdsPerOperation + 1),
        toShootDayId: "SD-2",
      }).success,
    ).toBe(false);
    expect(
      generateScheduleCandidatesInputSchema.safeParse({
        productionId: "PROD-DEMO",
        sceneIds: ids(INPUT_LIMITS.sceneIdsPerOperation + 1),
      }).success,
    ).toBe(false);
  });

  it("caps operations per simulation and per proposal", () => {
    const operations = (count: number) => Array.from({ length: count }, () => move(1));
    expect(
      simulateProposalInputSchema.safeParse({
        productionId: "PROD-DEMO",
        baseProductionVersion: 1,
        operations: operations(INPUT_LIMITS.operationsPerProposal),
      }).success,
    ).toBe(true);
    expect(
      simulateProposalInputSchema.safeParse({
        productionId: "PROD-DEMO",
        baseProductionVersion: 1,
        operations: operations(INPUT_LIMITS.operationsPerProposal + 1),
      }).success,
    ).toBe(false);
    expect(
      createProposalInputSchema.safeParse({
        productionId: "PROD-DEMO",
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: operations(INPUT_LIMITS.operationsPerProposal + 1),
        summary: "too many",
      }).success,
    ).toBe(false);
  });

  it("caps the dates a candidate search may exclude", () => {
    const dates = (count: number) =>
      Array.from({ length: count }, (_, index) => {
        const day = new Date(Date.UTC(2020, 0, 1 + index));
        return day.toISOString().slice(0, 10);
      });
    expect(
      generateScheduleCandidatesInputSchema.safeParse({
        productionId: "PROD-DEMO",
        sceneIds: ["S1"],
        excludeDates: dates(INPUT_LIMITS.excludeDates),
      }).success,
    ).toBe(true);
    expect(
      generateScheduleCandidatesInputSchema.safeParse({
        productionId: "PROD-DEMO",
        sceneIds: ["S1"],
        excludeDates: dates(INPUT_LIMITS.excludeDates + 1),
      }).success,
    ).toBe(false);
  });
});
