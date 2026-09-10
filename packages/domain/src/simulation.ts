import type {
  Conflict,
  EntityId,
  Impact,
  ProposedOperation,
  Requirement,
  SimulationSummary,
  Task,
  TypedChange,
} from "@pca/contracts";

import { ImpactCollector, analyzeImpact } from "./impact";
import { checkStateInvariants } from "./invariants/state";
import { isOperationAlreadyApplied } from "./operations";
import type { ProductionIndex, ProductionState } from "./production-state";
import { indexProduction, scheduledShootDay } from "./production-state";

/**
 * Proposal simulation (SPEC.md FR-3/FR-4, MCP.md §5).
 *
 * Apply operations to a copy of the snapshot, then judge the copy by the same
 * invariants that judge the live production. Nothing here writes: the caller
 * receives a would-be state and throws it away, or hands it to the apply path.
 *
 * `applyOperations` is shared with that apply path on purpose. Simulation runs
 * it with placeholder IDs; apply runs it with real ones. The two can therefore
 * not drift apart, which is what makes "what you approved is what happens"
 * true rather than hoped.
 */

/** Hands out IDs for entities an operation creates. */
export type IdAllocator = (prefix: "REQ" | "T") => EntityId;

/** Deterministic placeholders such as `SIM-REQ-1`, for simulation only. */
export const simulationIds = (): IdAllocator => {
  const counters = new Map<string, number>();
  return (prefix) => {
    const value = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, value);
    return `SIM-${prefix}-${value}`;
  };
};

export type SkippedOperation = {
  readonly operation: ProposedOperation;
  readonly reason: string;
};

export type OperationApplication = {
  readonly state: ProductionState;
  readonly applied: ProposedOperation[];
  /** Operations whose effect was already true of the world (INV-8). */
  readonly skipped: SkippedOperation[];
  /** Operations that could not be applied at all; the state excludes their effect. */
  readonly conflicts: Conflict[];
  readonly createdRequirements: Requirement[];
  readonly createdTasks: Task[];
  readonly staleCallSheetIds: EntityId[];
};

type Mutable = {
  -readonly [K in keyof ProductionState]: ProductionState[K] extends readonly (infer T)[]
    ? T[]
    : ProductionState[K];
};

const copyState = (state: ProductionState): Mutable => ({
  production: { ...state.production },
  scenes: state.scenes.map((scene) => ({ ...scene, requirementIds: [...scene.requirementIds] })),
  castMembers: [...state.castMembers],
  locations: [...state.locations],
  requirements: [...state.requirements],
  shootDays: state.shootDays.map((day) => ({ ...day, sceneIds: [...day.sceneIds] })),
  callSheets: state.callSheets.map((sheet) => ({ ...sheet })),
  tasks: [...state.tasks],
});

const unknown = (entityType: Conflict["entityType"], entityId: EntityId): Conflict => ({
  code: "UNKNOWN_ENTITY_REFERENCE",
  entityType,
  entityId,
  detail: `${entityType} ${entityId} does not exist in this production.`,
});

/**
 * Applies operations in order to a copy of the state.
 *
 * Each operation is atomic: it either takes full effect or contributes a
 * conflict and leaves the state untouched. Later operations see the effect of
 * earlier ones, so a move followed by a stale-marking of the same day behaves
 * the way a coordinator reading the list top to bottom expects.
 */
export const applyOperations = (
  state: ProductionState,
  operations: readonly ProposedOperation[],
  allocateId: IdAllocator,
): OperationApplication => {
  const draft = copyState(state);
  const applied: ProposedOperation[] = [];
  const skipped: SkippedOperation[] = [];
  const conflicts: Conflict[] = [];
  const createdRequirements: Requirement[] = [];
  const createdTasks: Task[] = [];
  const staleCallSheetIds: EntityId[] = [];

  for (const operation of operations) {
    const index = indexProduction(draft);

    if (isOperationAlreadyApplied(index, operation)) {
      skipped.push({ operation, reason: alreadyAppliedReason(index, operation) });
      continue;
    }

    switch (operation.type) {
      case "MOVE_SCENES": {
        const from = draft.shootDays.find((day) => day.id === operation.fromShootDayId);
        const to = draft.shootDays.find((day) => day.id === operation.toShootDayId);
        if (from === undefined) {
          conflicts.push(unknown("SHOOT_DAY", operation.fromShootDayId));
          break;
        }
        if (to === undefined) {
          conflicts.push(unknown("SHOOT_DAY", operation.toShootDayId));
          break;
        }

        const problems: Conflict[] = [];
        for (const sceneId of operation.sceneIds) {
          const scene = index.sceneById.get(sceneId);
          if (scene === undefined) {
            problems.push(unknown("SCENE", sceneId));
          } else if (to.sceneIds.includes(sceneId)) {
            problems.push({
              code: "SCENE_ALREADY_ON_SHOOT_DAY",
              entityType: "SCENE",
              entityId: sceneId,
              date: to.date,
              detail: `Scene ${scene.sceneNumber} is already scheduled on ${to.date}.`,
            });
          } else if (!from.sceneIds.includes(sceneId)) {
            const actual = scheduledShootDay(index, sceneId);
            problems.push({
              code: "SCENE_MISSING_FROM_SHOOT_DAY",
              entityType: "SCENE",
              entityId: sceneId,
              date: from.date,
              detail:
                actual === null
                  ? `Scene ${scene.sceneNumber} is not scheduled on ${from.date}; it is unscheduled.`
                  : `Scene ${scene.sceneNumber} is not scheduled on ${from.date}; it is on ${actual.date}.`,
            });
          }
        }
        if (problems.length > 0) {
          conflicts.push(...problems);
          break;
        }

        from.sceneIds = from.sceneIds.filter((sceneId) => !operation.sceneIds.includes(sceneId));
        to.sceneIds = [...to.sceneIds, ...operation.sceneIds];
        applied.push(operation);
        break;
      }

      case "ADD_SCENE_REQUIREMENT": {
        const scene = draft.scenes.find((candidate) => candidate.id === operation.sceneId);
        if (scene === undefined) {
          conflicts.push(unknown("SCENE", operation.sceneId));
          break;
        }
        const requirement: Requirement = {
          id: allocateId("REQ"),
          productionId: draft.production.id,
          sceneId: scene.id,
          type: operation.requirementType,
          name: operation.name,
          status: "NEEDED",
        };
        draft.requirements.push(requirement);
        scene.requirementIds.push(requirement.id);
        createdRequirements.push(requirement);
        applied.push(operation);
        break;
      }

      case "CREATE_PREPARATION_TASK": {
        const task: Task = {
          id: allocateId("T"),
          productionId: draft.production.id,
          title: operation.title,
          relatedEntityType: operation.relatedEntityType,
          relatedEntityId: operation.relatedEntityId,
          status: "OPEN",
        };
        draft.tasks.push(task);
        createdTasks.push(task);
        applied.push(operation);
        break;
      }

      case "MARK_CALL_SHEET_STALE": {
        const callSheet = draft.callSheets.find((sheet) => sheet.id === operation.callSheetId);
        if (callSheet === undefined) {
          conflicts.push(unknown("CALL_SHEET", operation.callSheetId));
          break;
        }
        callSheet.status = "DRAFT";
        staleCallSheetIds.push(callSheet.id);
        applied.push(operation);
        break;
      }
    }
  }

  return {
    state: draft,
    applied,
    skipped,
    conflicts,
    createdRequirements,
    createdTasks,
    staleCallSheetIds,
  };
};

const alreadyAppliedReason = (index: ProductionIndex, operation: ProposedOperation): string => {
  switch (operation.type) {
    case "MOVE_SCENES":
      return `Scenes ${operation.sceneIds.join(", ")} are already on ${index.shootDayById.get(operation.toShootDayId)?.date ?? operation.toShootDayId}; nothing to move.`;
    case "ADD_SCENE_REQUIREMENT":
      return `Scene ${index.sceneById.get(operation.sceneId)?.sceneNumber ?? operation.sceneId} already has the ${operation.requirementType} "${operation.name}"; nothing to add.`;
    case "CREATE_PREPARATION_TASK":
      return `An open task "${operation.title}" already exists; nothing to create.`;
    case "MARK_CALL_SHEET_STALE":
      return `Call sheet ${operation.callSheetId} is already a draft; nothing to mark.`;
  }
};

/** The change each operation amounts to, so the impact engine can describe it. */
const changeFor = (operation: ProposedOperation): TypedChange | null => {
  switch (operation.type) {
    case "MOVE_SCENES":
      return {
        type: "SCHEDULE_CHANGED",
        sceneIds: [...operation.sceneIds],
        toShootDayId: operation.toShootDayId,
      };
    case "ADD_SCENE_REQUIREMENT":
      return {
        type: "SCENE_REQUIREMENT_CHANGED",
        sceneId: operation.sceneId,
        requirement: { type: operation.requirementType, name: operation.name },
      };
    case "CREATE_PREPARATION_TASK":
    case "MARK_CALL_SHEET_STALE":
      return null;
  }
};

export type SimulationOutcome = {
  readonly valid: boolean;
  readonly impacts: Impact[];
  /** Everything wrong with the would-be state, plus operations that could not apply. */
  readonly conflicts: Conflict[];
  /** Violations of the current state that the operations make go away. */
  readonly resolvedConflicts: Conflict[];
  readonly warnings: string[];
  readonly summary: SimulationSummary;
  readonly postState: ProductionState;
  readonly applied: ProposedOperation[];
  readonly skipped: SkippedOperation[];
};

const conflictKey = (conflict: Conflict): string =>
  `${conflict.code}:${conflict.entityType}:${conflict.entityId}:${conflict.date ?? ""}`;

const summarize = (
  state: ProductionState,
  application: OperationApplication,
): SimulationSummary => ({
  shootDays: [...state.shootDays]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({ id: day.id, date: day.date, sceneIds: [...day.sceneIds] })),
  addedRequirementNames: application.createdRequirements.map((requirement) => requirement.name),
  addedTaskTitles: application.createdTasks.map((task) => task.title),
  staleCallSheetIds: [...application.staleCallSheetIds],
});

/**
 * A proposal is valid when the would-be state satisfies every invariant and
 * every operation could apply. A proposal that fixes one scene but leaves a
 * second one conflicting is therefore invalid: the product's promise is that
 * an approved plan is a valid plan, not merely a better one.
 */
export const simulateProposal = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
  allocateId: IdAllocator = simulationIds(),
): SimulationOutcome => {
  const application = applyOperations(index.state, operations, allocateId);
  const postIndex = indexProduction(application.state);

  const before = new Map(
    checkStateInvariants(index).map((violation) => [
      conflictKey(violation.conflict),
      violation.conflict,
    ]),
  );
  const after = checkStateInvariants(postIndex).map((violation) => violation.conflict);
  const afterKeys = new Set(after.map(conflictKey));
  const resolvedConflicts = [...before.entries()]
    .filter(([key]) => !afterKeys.has(key))
    .map(([, conflict]) => conflict);

  const collector = new ImpactCollector();
  for (const operation of application.applied) {
    const change = changeFor(operation);
    if (change === null) {
      continue;
    }
    const analysis = analyzeImpact(index, change);
    for (const impact of analysis.impacts) {
      collector.add(impact);
    }
  }
  const { impacts } = collector.result();

  const conflicts = [...application.conflicts, ...after];
  const warnings = [
    ...impacts
      .filter((impact) => impact.severity === "WARNING")
      .map((impact) => impact.explanation),
    ...application.skipped.map((entry) => entry.reason),
  ];

  return {
    valid: conflicts.length === 0,
    impacts,
    conflicts,
    resolvedConflicts,
    warnings,
    summary: summarize(application.state, application),
    postState: application.state,
    applied: application.applied,
    skipped: application.skipped,
  };
};
