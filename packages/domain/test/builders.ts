import type {
  CallSheet,
  CastMember,
  Location,
  Production,
  Proposal,
  Requirement,
  Scene,
  ShootDay,
  Task,
} from "@pca/contracts";

import type { ProductionState } from "../src/production-state";

/**
 * Minimal builders for invariant tests.
 *
 * These are deliberately not the Demo Movie fixture (TASK-004). An invariant
 * test should construct the smallest state that exhibits the rule, so a failure
 * points at the rule rather than at a shared fixture that drifted.
 */

const PRODUCTION_ID = "PROD-TEST";

export const aProduction = (overrides: Partial<Production> = {}): Production => ({
  id: PRODUCTION_ID,
  name: "Test Production",
  timezone: "Asia/Manila",
  version: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

export const aScene = (overrides: Partial<Scene> = {}): Scene => ({
  id: "S01",
  productionId: PRODUCTION_ID,
  sceneNumber: "01",
  locationId: "LOC-CAFE",
  requiredCastIds: [],
  requirementIds: [],
  estimatedMinutes: 30,
  ...overrides,
});

export const aCastMember = (overrides: Partial<CastMember> = {}): CastMember => ({
  id: "CAST-SARAH",
  productionId: PRODUCTION_ID,
  name: "Sarah",
  unavailable: [],
  ...overrides,
});

export const aLocation = (overrides: Partial<Location> = {}): Location => ({
  id: "LOC-CAFE",
  productionId: PRODUCTION_ID,
  name: "Cafe",
  unavailable: [],
  ...overrides,
});

export const aRequirement = (overrides: Partial<Requirement> = {}): Requirement => ({
  id: "REQ-1",
  productionId: PRODUCTION_ID,
  sceneId: "S01",
  type: "PROP",
  name: "red car",
  status: "NEEDED",
  ...overrides,
});

export const aShootDay = (overrides: Partial<ShootDay> = {}): ShootDay => ({
  id: "SD-2026-09-18",
  productionId: PRODUCTION_ID,
  date: "2026-09-18",
  sceneIds: [],
  status: "CONFIRMED",
  ...overrides,
});

export const aCallSheet = (overrides: Partial<CallSheet> = {}): CallSheet => ({
  id: "CS-2026-09-18",
  productionId: PRODUCTION_ID,
  shootDayId: "SD-2026-09-18",
  version: 1,
  status: "PUBLISHED",
  ...overrides,
});

export const aTask = (overrides: Partial<Task> = {}): Task => ({
  id: "T-1",
  productionId: PRODUCTION_ID,
  title: "Source a red car",
  relatedEntityType: "SCENE",
  relatedEntityId: "S01",
  status: "OPEN",
  ...overrides,
});

export const aProductionState = (overrides: Partial<ProductionState> = {}): ProductionState => ({
  production: aProduction(),
  scenes: [],
  castMembers: [],
  locations: [],
  requirements: [],
  shootDays: [],
  callSheets: [],
  tasks: [],
  ...overrides,
});

export const aProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: "P-104",
  productionId: PRODUCTION_ID,
  changeRequestId: "CR-001",
  baseProductionVersion: 12,
  operations: [
    {
      type: "MOVE_SCENES",
      sceneIds: ["S07"],
      fromShootDayId: "SD-2026-09-18",
      toShootDayId: "SD-2026-09-21",
    },
  ],
  impacts: [],
  conflicts: [],
  warnings: [],
  validationStatus: "VALID",
  status: "AWAITING_APPROVAL",
  digest: "a".repeat(64),
  summary: "Move Scene 07 to Monday.",
  createdAt: "2026-09-10T11:04:00.000Z",
  ...overrides,
});
