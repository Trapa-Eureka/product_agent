import type {
  AuditEvent,
  ChangeRequest,
  EntityId,
  InterpretationOption,
  Proposal,
  ProposedOperation,
  RankedCandidate,
  RejectedScheduleDay,
  ScheduleCandidate,
  TypedChange,
} from "@pca/contracts";
import type { ProductionIndex, ProductionState } from "@pca/domain";
import { callSheetsFor, indexProduction, scheduledShootDay } from "@pca/domain";

import type { Clock, IdFactory, ModelPort, RepositorySet } from "../ports";
import { ModelError, guardModelPort } from "../ports";
import type { UseCaseResult } from "../result";
import { succeed } from "../result";
import { createAnalyzeChangeImpact, type ChangeImpactReport } from "./analyze-change-impact";
import { createCreateProposal } from "./create-proposal";
import { createGenerateScheduleCandidates } from "./generate-schedule-candidates";
import { createInterpretChange } from "./interpret-change";
import { createSimulateProposal } from "./simulate-proposal";
import { createSubmitChangeRequest } from "./submit-change-request";

/**
 * The agent's read-analyze-simulate-propose loop (TASK-305, ARCHITECTURE.md §8).
 *
 * interpret → intake → analyze → candidates → rank → simulate → explain → propose.
 *
 * Every step before "propose" is a read or a record; the proposal itself is a
 * persisted plan awaiting a human. No production state changes here, on any
 * path, and a test proves it for each outcome.
 *
 * The model is asked three things and only three: to read the sentence, to
 * order candidates the engine already validated, and to put findings into
 * prose. The plan's shape is deterministic code, the same shape the golden
 * suite pins: the recorded fact first, then the remedy, then a stale mark for
 * every touched call sheet.
 */

export type RunChangeAgentInput = {
  readonly productionId: EntityId;
  /** Either a sentence to interpret or an already-resolved change from the resolution step. */
  readonly text: string;
  readonly change?: TypedChange;
  readonly requestedBy: string;
  readonly correlationId?: string;
};

export type AgentOutcome =
  | {
      readonly kind: "NEEDS_RESOLUTION";
      readonly question: string;
      readonly options: InterpretationOption[];
    }
  | {
      readonly kind: "PROPOSED";
      readonly changeRequest: ChangeRequest;
      readonly analysis: ChangeImpactReport;
      readonly candidates: ScheduleCandidate[];
      readonly ranked: RankedCandidate[];
      readonly rejected: RejectedScheduleDay[];
      readonly proposal: Proposal;
      readonly explanation: string;
    }
  | {
      readonly kind: "NO_CANDIDATE";
      readonly changeRequest: ChangeRequest;
      readonly analysis: ChangeImpactReport;
      readonly rejected: RejectedScheduleDay[];
      readonly explanation: string;
    }
  | {
      readonly kind: "NOTHING_TO_DO";
      readonly changeRequest: ChangeRequest;
      readonly analysis: ChangeImpactReport;
      readonly explanation: string;
    };

export type RunChangeAgent = (input: RunChangeAgentInput) => Promise<UseCaseResult<AgentOutcome>>;

const staleMarks = (
  index: ProductionIndex,
  shootDayIds: readonly EntityId[],
): ProposedOperation[] => {
  const seen = new Set<EntityId>();
  const marks: ProposedOperation[] = [];
  for (const shootDayId of shootDayIds) {
    for (const sheet of callSheetsFor(index, shootDayId)) {
      if (sheet.status === "PUBLISHED" && !seen.has(sheet.id)) {
        seen.add(sheet.id);
        marks.push({ type: "MARK_CALL_SHEET_STALE", callSheetId: sheet.id });
      }
    }
  }
  return marks;
};

/** Scenes the analysis found blocked, grouped by the day they currently sit on. */
const blockedScenesByDay = (
  index: ProductionIndex,
  analysis: ChangeImpactReport,
): Map<EntityId, EntityId[]> => {
  const grouped = new Map<EntityId, EntityId[]>();
  for (const impact of analysis.impacts) {
    if (impact.severity !== "BLOCKING" || impact.entityType !== "SCENE") continue;
    const day = scheduledShootDay(index, impact.entityId);
    if (day === null) continue;
    grouped.set(day.id, [...(grouped.get(day.id) ?? []), impact.entityId]);
  }
  return grouped;
};

const moveOperations = (
  grouped: Map<EntityId, EntityId[]>,
  toShootDayId: EntityId,
): ProposedOperation[] =>
  [...grouped.entries()]
    .filter(([fromShootDayId]) => fromShootDayId !== toShootDayId)
    .map(([fromShootDayId, sceneIds]) => ({
      type: "MOVE_SCENES",
      sceneIds,
      fromShootDayId,
      toShootDayId,
    }));

const factOperation = (change: TypedChange): ProposedOperation | null => {
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return {
        type: "RECORD_CAST_UNAVAILABILITY",
        castId: change.castId,
        unavailable: change.unavailable,
      };
    case "LOCATION_UNAVAILABLE":
      return {
        type: "RECORD_LOCATION_UNAVAILABILITY",
        locationId: change.locationId,
        unavailable: change.unavailable,
      };
    default:
      return null;
  }
};

export const createRunChangeAgent = (dependencies: {
  readonly repositories: RepositorySet;
  readonly model: ModelPort;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly modelTimeoutMs?: number;
}): RunChangeAgent => {
  const { repositories, clock, ids } = dependencies;
  const guardOptions =
    dependencies.modelTimeoutMs === undefined ? {} : { timeoutMs: dependencies.modelTimeoutMs };
  const model = guardModelPort(dependencies.model, guardOptions);
  const interpret = createInterpretChange({
    repositories,
    model,
    clock,
    ...(guardOptions.timeoutMs === undefined ? {} : { modelTimeoutMs: guardOptions.timeoutMs }),
  });
  const submit = createSubmitChangeRequest({ repositories, clock, ids });
  const analyze = createAnalyzeChangeImpact({ repositories });
  const generate = createGenerateScheduleCandidates({ repositories });
  const simulate = createSimulateProposal({ repositories });
  const propose = createCreateProposal({ repositories, clock, ids });

  const audit = async (
    productionId: EntityId,
    correlationId: string,
    actorType: "AGENT" | "SYSTEM",
    action: string,
    entityId: EntityId,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    const event: AuditEvent = {
      id: ids.next("AE"),
      productionId,
      actorType,
      action,
      entityType: "CHANGE_REQUEST",
      entityId,
      correlationId,
      metadata,
      createdAt: clock.now(),
    };
    await repositories.auditEvents.append(event);
  };

  const explain = async (
    input: Parameters<ModelPort["explainImpact"]>[0],
    fallback: string,
  ): Promise<string> => {
    try {
      return (await model.explainImpact(input)).explanation;
    } catch (error) {
      if (error instanceof ModelError) return fallback;
      throw error;
    }
  };

  return async (input) => {
    const correlationId = input.correlationId ?? ids.next("corr");
    const trace = { correlationId };

    let change = input.change;
    if (change === undefined) {
      const interpreted = await interpret({
        productionId: input.productionId,
        text: input.text,
        correlationId,
      });
      if (!interpreted.ok) return interpreted;
      if (interpreted.value.kind === "AMBIGUOUS") {
        return succeed({
          kind: "NEEDS_RESOLUTION",
          question: interpreted.value.question,
          options: interpreted.value.options,
        });
      }
      change = interpreted.value.change;
    }

    const submitted = await submit({
      productionId: input.productionId,
      rawText: input.text,
      change,
      createdBy: input.requestedBy,
      correlationId,
    });
    if (!submitted.ok) return submitted;
    const changeRequest = submitted.value;

    await audit(
      input.productionId,
      correlationId,
      "AGENT",
      "ANALYSIS_REQUESTED",
      changeRequest.id,
      { changeType: change.type },
    );
    const analyzed = await analyze({ productionId: input.productionId, change, correlationId });
    if (!analyzed.ok) return analyzed;
    const analysis = analyzed.value;
    await audit(
      input.productionId,
      correlationId,
      "SYSTEM",
      "ANALYSIS_COMPLETED",
      changeRequest.id,
      {
        conflictCount: analysis.conflicts.length,
        affectedEntityCount: analysis.affectedEntityIds.length,
      },
    );

    const state = (await repositories.productions.loadState(input.productionId)) as ProductionState;
    const index = indexProduction(state);
    const explainInput = {
      productionId: input.productionId,
      rawText: input.text,
      change,
      impacts: analysis.impacts,
      conflicts: analysis.conflicts,
    };

    let operations: ProposedOperation[];
    let candidates: ScheduleCandidate[] = [];
    let ranked: RankedCandidate[] = [];
    let rejected: RejectedScheduleDay[] = [];

    switch (change.type) {
      case "CAST_UNAVAILABLE":
      case "LOCATION_UNAVAILABLE": {
        const fact = factOperation(change) as ProposedOperation;
        const grouped = blockedScenesByDay(index, analysis);
        const sceneIds = [...grouped.values()].flat();
        if (sceneIds.length === 0) {
          operations = [fact];
          break;
        }
        const generated = await generate({
          productionId: input.productionId,
          sceneIds,
          correlationId,
        });
        if (!generated.ok) return generated;
        candidates = generated.value.candidates;
        rejected = generated.value.rejected;
        if (candidates.length === 0) {
          const explanation = await explain(
            explainInput,
            "No shoot day can take the affected scenes.",
          );
          return succeed({ kind: "NO_CANDIDATE", changeRequest, analysis, rejected, explanation });
        }
        try {
          ranked = (
            await model.rankCandidates({
              productionId: input.productionId,
              change,
              candidates,
              rejected,
            })
          ).ranked;
        } catch (error) {
          if (!(error instanceof ModelError)) throw error;
          ranked = candidates.map((candidate, position) => ({
            shootDayId: candidate.shootDayId,
            rank: position + 1,
            reason: "Ordered by date; the model did not answer.",
          }));
        }
        const target =
          ranked.find((entry) => entry.rank === 1)?.shootDayId ?? candidates[0]!.shootDayId;
        operations = [
          fact,
          ...moveOperations(grouped, target),
          ...staleMarks(index, [...grouped.keys(), target]),
        ];
        break;
      }
      case "SCENE_REQUIREMENT_CHANGED": {
        if (
          analysis.impacts.some(
            (impact) => impact.reasonCode === "SCENE_REQUIREMENT_ALREADY_PRESENT",
          )
        ) {
          const explanation = await explain(
            explainInput,
            "The scene already has that requirement.",
          );
          return succeed({ kind: "NOTHING_TO_DO", changeRequest, analysis, explanation });
        }
        const scene = index.sceneById.get(change.sceneId);
        const day = scheduledShootDay(index, change.sceneId);
        operations = [
          {
            type: "ADD_SCENE_REQUIREMENT",
            sceneId: change.sceneId,
            requirementType: change.requirement.type,
            name: change.requirement.name,
          },
          {
            type: "CREATE_PREPARATION_TASK",
            title: `Source a ${change.requirement.name} for Scene ${scene?.sceneNumber ?? change.sceneId}`,
            relatedEntityType: "SCENE",
            relatedEntityId: change.sceneId,
          },
          ...(day === null ? [] : staleMarks(index, [day.id])),
        ];
        break;
      }
      case "SCHEDULE_CHANGED": {
        const grouped = new Map<EntityId, EntityId[]>();
        for (const sceneId of change.sceneIds) {
          const day = scheduledShootDay(index, sceneId);
          if (day !== null) grouped.set(day.id, [...(grouped.get(day.id) ?? []), sceneId]);
        }
        operations = [
          ...moveOperations(grouped, change.toShootDayId),
          ...staleMarks(index, [...grouped.keys(), change.toShootDayId]),
        ];
        break;
      }
    }

    const simulated = await simulate({
      productionId: input.productionId,
      baseProductionVersion: analysis.productionVersion,
      operations,
      correlationId,
    });
    if (!simulated.ok) return simulated;
    const explanation = await explain(
      {
        ...explainInput,
        impacts: simulated.value.impacts.length > 0 ? simulated.value.impacts : analysis.impacts,
        resolvedConflicts: simulated.value.resolvedConflicts,
        warnings: simulated.value.warnings,
      },
      `${operations.length} operations proposed.`,
    );

    const proposed = await propose({
      productionId: input.productionId,
      changeRequestId: changeRequest.id,
      baseProductionVersion: analysis.productionVersion,
      operations,
      summary: explanation,
      proposedBy: "agent",
      actorType: "AGENT",
      ...trace,
    });
    if (!proposed.ok) return proposed;

    return succeed({
      kind: "PROPOSED",
      changeRequest,
      analysis,
      candidates,
      ranked,
      rejected,
      proposal: proposed.value,
      explanation,
    });
  };
};
