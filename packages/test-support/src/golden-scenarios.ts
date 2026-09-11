import { beforeAll, describe, expect, it } from "vitest";

import type {
  AuditEvent,
  ChangeRequest,
  Proposal,
  ProposedOperation,
  TypedChange,
} from "@pca/contracts";
import type { RepositorySet } from "@pca/application";
import {
  createAnalyzeChangeImpact,
  createApplyApprovedProposal,
  createCreateProposal,
  createDecideProposal,
  createGenerateScheduleCandidates,
  createSimulateProposal,
  createSubmitChangeRequest,
  createVerifyAppliedProposal,
  type ApplyResult,
  type ChangeImpactReport,
  type ScheduleCandidateReport,
  type SimulationReport,
  type UseCaseResult,
  type VerificationReport,
} from "@pca/application";
import type { ProductionState } from "@pca/domain";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";

import { fixedClock, sequentialIds } from "./determinism";
import { onDay } from "./scenario";
import { approver } from "./identity";

/**
 * The golden scenarios (TESTING.md §4), as one suite that runs against any
 * repository adapter.
 *
 * These are the project's most important acceptance signal. Each `it` is one
 * bullet from TESTING.md, in its words, so a regression names the promise it
 * broke. The pipeline runs once per scenario in `beforeAll`; the assertions
 * then read the artefacts of each stage rather than re-running it, which keeps
 * a failure in one bullet from hiding the others.
 *
 * Between simulation and approval, the operations are assembled the way the
 * orchestrator (TASK-305) will assemble them: the recorded fact, the move to
 * the first valid candidate, and a stale mark for each touched call sheet.
 */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T11:03:00.000Z";
const COORDINATOR = "coordinator@example.test";

export type GoldenRepositoryFactory = () => Promise<RepositorySet>;

type Stages = {
  changeRequest: ChangeRequest;
  analysis: ChangeImpactReport;
  candidates: ScheduleCandidateReport | null;
  operations: ProposedOperation[];
  simulation: SimulationReport;
  proposal: Proposal;
  stateBeforeApproval: ProductionState;
  applyWithoutApproval: UseCaseResult<ApplyResult>;
  stateAfterRefusedApply: ProductionState;
  applied: ApplyResult;
  replay: ApplyResult;
  resimulated: SimulationReport;
  stateAfter: ProductionState;
  verification: VerificationReport;
  audit: AuditEvent[];
};

const unwrap = <T>(result: UseCaseResult<T>, stage: string): T => {
  if (!result.ok) {
    throw new Error(`${stage} failed: ${result.error.code} ${result.error.message}`);
  }
  return result.value;
};

const staleMarks = (state: ProductionState, shootDayIds: readonly string[]): ProposedOperation[] =>
  state.callSheets
    .filter((sheet) => shootDayIds.includes(sheet.shootDayId))
    .map((sheet) => ({ type: "MARK_CALL_SHEET_STALE", callSheetId: sheet.id }));

const runScenario = async (
  createRepositories: GoldenRepositoryFactory,
  scenario: {
    rawText: string;
    change: TypedChange;
    /** How the orchestrator turns analysis and candidates into a plan. */
    plan: (
      state: ProductionState,
      analysis: ChangeImpactReport,
      candidates: ScheduleCandidateReport | null,
    ) => ProposedOperation[];
    movingSceneIds?: string[];
  },
): Promise<Stages> => {
  const repositories = await createRepositories();
  await repositories.productions.save(createDemoMovie());
  const deps = { repositories, clock: fixedClock(NOW), ids: sequentialIds() };

  const submit = createSubmitChangeRequest(deps);
  const analyze = createAnalyzeChangeImpact({ repositories });
  const generate = createGenerateScheduleCandidates({ repositories });
  const simulate = createSimulateProposal({ repositories });
  const create = createCreateProposal(deps);
  const decide = createDecideProposal(deps);
  const apply = createApplyApprovedProposal(deps);
  const verify = createVerifyAppliedProposal(deps);

  const changeRequest = unwrap(
    await submit({
      productionId: DEMO,
      rawText: scenario.rawText,
      change: scenario.change,
      createdBy: COORDINATOR,
    }),
    "submit",
  );
  const analysis = unwrap(
    await analyze({ productionId: DEMO, change: scenario.change }),
    "analyze",
  );
  const candidates =
    scenario.movingSceneIds === undefined
      ? null
      : unwrap(
          await generate({ productionId: DEMO, sceneIds: scenario.movingSceneIds }),
          "candidates",
        );

  const stateBeforeApproval = (await repositories.productions.loadState(DEMO))!;
  const operations = scenario.plan(stateBeforeApproval, analysis, candidates);
  const simulation = unwrap(
    await simulate({
      productionId: DEMO,
      baseProductionVersion: analysis.productionVersion,
      operations,
    }),
    "simulate",
  );
  const proposal = unwrap(
    await create({
      productionId: DEMO,
      changeRequestId: changeRequest.id,
      baseProductionVersion: analysis.productionVersion,
      operations,
      summary: scenario.rawText,
      proposedBy: "agent",
    }),
    "create",
  );

  const applyWithoutApproval = await apply({
    productionId: DEMO,
    proposalId: proposal.id,
    approvalId: "A-NONE",
    expectedProductionVersion: proposal.baseProductionVersion,
    idempotencyKey: `apply:${proposal.id}:premature`,
  });
  const stateAfterRefusedApply = (await repositories.productions.loadState(DEMO))!;

  const decision = unwrap(
    await decide({
      productionId: DEMO,
      proposalId: proposal.id,
      decision: "APPROVE",
      decidedBy: approver(COORDINATOR),
    }),
    "decide",
  );
  const applyInput = {
    productionId: DEMO,
    proposalId: proposal.id,
    approvalId: decision.approval.id,
    expectedProductionVersion: proposal.baseProductionVersion,
    idempotencyKey: `apply:${proposal.id}:first`,
  };
  const applied = unwrap(await apply(applyInput), "apply");
  const replay = unwrap(await apply(applyInput), "replay");
  const resimulated = unwrap(
    await simulate({
      productionId: DEMO,
      baseProductionVersion: applied.productionVersion,
      operations,
    }),
    "re-simulate",
  );
  const stateAfter = (await repositories.productions.loadState(DEMO))!;
  const verification = unwrap(
    await verify({ productionId: DEMO, proposalId: proposal.id }),
    "verify",
  );
  const audit = await repositories.auditEvents.list(DEMO);

  return {
    changeRequest,
    analysis,
    candidates,
    operations,
    simulation,
    proposal,
    stateBeforeApproval,
    applyWithoutApproval,
    stateAfterRefusedApply,
    applied,
    replay,
    resimulated,
    stateAfter,
    verification,
    audit,
  };
};

const affectedOf = (analysis: ChangeImpactReport, entityType: string): string[] =>
  analysis.impacts
    .filter((impact) => impact.entityType === entityType)
    .map((impact) => impact.entityId);

const sceneIdsOn = (state: ProductionState, shootDayId: string): readonly string[] =>
  state.shootDays.find((day) => day.id === shootDayId)?.sceneIds ?? [];

/** Assertions every scenario shares: the approval boundary and the audit story. */
const itHoldsTheApprovalBoundary = (stages: () => Stages): void => {
  it("no mutation before approval", () => {
    const { stateBeforeApproval, stateAfterRefusedApply, proposal } = stages();
    expect(stateBeforeApproval.production.version).toBe(proposal.baseProductionVersion);
    expect(stateAfterRefusedApply).toEqual(stateBeforeApproval);
  });

  it("approval required", () => {
    const { applyWithoutApproval } = stages();
    expect(applyWithoutApproval.ok).toBe(false);
    if (applyWithoutApproval.ok) return;
    expect(applyWithoutApproval.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("verification passes", () => {
    const { verification } = stages();
    expect(verification.checks.filter((check) => !check.passed)).toEqual([]);
    expect(verification.success).toBe(true);
  });

  it("the audit trail tells the whole story, without chain-of-thought", () => {
    const actions = stages()
      .audit.map((event) => event.action)
      .reverse();
    expect(actions).toEqual([
      "CHANGE_REQUEST_SUBMITTED",
      "PROPOSAL_CREATED",
      "PROPOSAL_APPROVED",
      "PROPOSAL_APPLIED",
      "PROPOSAL_VERIFIED",
    ]);
    for (const event of stages().audit) {
      expect(JSON.stringify(event)).not.toMatch(/thinking|reasoning|chain/iu);
    }
  });
};

export const describeGoldenScenarios = (
  adapterName: string,
  createRepositories: GoldenRepositoryFactory,
): void => {
  describe(`golden scenarios on ${adapterName}`, () => {
    describe("GOLDEN-1 Sarah unavailable Friday", () => {
      let stages: Stages;

      beforeAll(async () => {
        stages = await runScenario(createRepositories, {
          rawText: "Sarah cannot shoot Friday.",
          change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
          movingSceneIds: [scenes.s07, scenes.s12],
          plan: (state, _analysis, candidates) => {
            const target = candidates?.candidates[0];
            if (target === undefined) throw new Error("expected a candidate day");
            return [
              {
                type: "RECORD_CAST_UNAVAILABILITY",
                castId: cast.sarah,
                unavailable: onDay(friday),
              },
              {
                type: "MOVE_SCENES",
                sceneIds: [scenes.s07, scenes.s12],
                fromShootDayId: shootDays.friday,
                toShootDayId: target.shootDayId,
              },
              ...staleMarks(state, [shootDays.friday, target.shootDayId]),
            ];
          },
        });
      });

      it("affected scenes = S07, S12", () => {
        expect(affectedOf(stages.analysis, "SCENE")).toEqual([scenes.s07, scenes.s12]);
      });

      it("Friday shoot day affected", () => {
        expect(affectedOf(stages.analysis, "SHOOT_DAY")).toEqual([shootDays.friday]);
      });

      it("Friday call sheet affected", () => {
        expect(affectedOf(stages.analysis, "CALL_SHEET")).toEqual([callSheets.friday]);
      });

      it("analysis contains blocking cast conflict", () => {
        expect(stages.analysis.conflicts.map((conflict) => conflict.code)).toEqual([
          "CAST_UNAVAILABLE_ON_SHOOT_DAY",
          "CAST_UNAVAILABLE_ON_SHOOT_DAY",
        ]);
        expect(
          stages.analysis.impacts.filter((impact) => impact.severity === "BLOCKING"),
        ).toHaveLength(2);
      });

      it("a valid Monday candidate exists", () => {
        expect(stages.candidates?.candidates[0]).toMatchObject({
          shootDayId: shootDays.monday,
          date: monday,
        });
        expect(stages.simulation.valid).toBe(true);
        expect(stages.proposal.status).toBe("AWAITING_APPROVAL");
      });

      itHoldsTheApprovalBoundary(() => stages);

      it("after approved move, S07/S12 are not on Friday", () => {
        expect(sceneIdsOn(stages.stateAfter, shootDays.friday)).toEqual([]);
        expect(sceneIdsOn(stages.stateAfter, shootDays.monday)).toEqual([
          scenes.s22,
          scenes.s07,
          scenes.s12,
        ]);
        expect(stages.applied.productionVersion).toBe(stages.proposal.baseProductionVersion + 1);
      });

      it("the production remembers that Sarah is unavailable Friday", () => {
        expect(
          stages.stateAfter.castMembers.find((member) => member.id === cast.sarah)?.unavailable,
        ).toEqual([onDay(friday)]);
      });
    });

    describe("GOLDEN-2 Warehouse unavailable Friday", () => {
      let stages: Stages;

      beforeAll(async () => {
        stages = await runScenario(createRepositories, {
          rawText: "The warehouse is unavailable Friday.",
          change: {
            type: "LOCATION_UNAVAILABLE",
            locationId: locations.warehouse,
            unavailable: onDay(friday),
          },
          movingSceneIds: [scenes.s07, scenes.s12],
          plan: (state, _analysis, candidates) => {
            const target = candidates?.candidates[0];
            if (target === undefined) throw new Error("expected a candidate day");
            return [
              {
                type: "RECORD_LOCATION_UNAVAILABILITY",
                locationId: locations.warehouse,
                unavailable: onDay(friday),
              },
              {
                type: "MOVE_SCENES",
                sceneIds: [scenes.s07, scenes.s12],
                fromShootDayId: shootDays.friday,
                toShootDayId: target.shootDayId,
              },
              ...staleMarks(state, [shootDays.friday, target.shootDayId]),
            ];
          },
        });
      });

      it("S07/S12 affected", () => {
        expect(affectedOf(stages.analysis, "SCENE")).toEqual([scenes.s07, scenes.s12]);
      });

      it("Friday schedule affected", () => {
        expect(affectedOf(stages.analysis, "SHOOT_DAY")).toEqual([shootDays.friday]);
      });

      it("cast implications include Sarah/John", () => {
        expect(affectedOf(stages.analysis, "CAST_MEMBER")).toEqual([cast.john, cast.sarah]);
      });

      it("call sheet affected", () => {
        expect(affectedOf(stages.analysis, "CALL_SHEET")).toEqual([callSheets.friday]);
      });

      it("valid candidate produced", () => {
        expect(stages.candidates?.candidates.map((candidate) => candidate.date)).toEqual([
          monday,
          DEMO_MOVIE_DATES.tuesday,
        ]);
        expect(stages.simulation.valid).toBe(true);
        expect(stages.simulation.resolvedConflicts.map((conflict) => conflict.code)).toEqual([
          "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
          "LOCATION_UNAVAILABLE_ON_SHOOT_DAY",
        ]);
      });

      itHoldsTheApprovalBoundary(() => stages);

      it("post-write: no Warehouse scene remains on Friday", () => {
        expect(sceneIdsOn(stages.stateAfter, shootDays.friday)).toEqual([]);
        expect(
          stages.stateAfter.locations.find((location) => location.id === locations.warehouse)
            ?.unavailable,
        ).toEqual([onDay(friday)]);
      });
    });

    describe("GOLDEN-3 Scene 18 needs red car", () => {
      let stages: Stages;

      beforeAll(async () => {
        stages = await runScenario(createRepositories, {
          rawText: "Scene 18 now needs a red car.",
          change: {
            type: "SCENE_REQUIREMENT_CHANGED",
            sceneId: scenes.s18,
            requirement: { type: "PROP", name: "red car" },
          },
          plan: (state) => [
            {
              type: "ADD_SCENE_REQUIREMENT",
              sceneId: scenes.s18,
              requirementType: "PROP",
              name: "red car",
            },
            {
              type: "CREATE_PREPARATION_TASK",
              title: "Source a red car for Scene 18",
              relatedEntityType: "SCENE",
              relatedEntityId: scenes.s18,
            },
            ...staleMarks(state, [shootDays.tuesday]),
          ],
        });
      });

      it("S18 affected", () => {
        expect(affectedOf(stages.analysis, "SCENE")).toEqual([scenes.s18]);
        expect(
          stages.analysis.impacts.find((impact) => impact.entityId === scenes.s18)?.reasonCode,
        ).toBe("SCENE_REQUIREMENT_ADDED");
      });

      it("new requirement proposed", () => {
        expect(stages.simulation.postStateSummary.addedRequirementNames).toEqual(["red car"]);
        expect(stages.proposal.operations[0]?.type).toBe("ADD_SCENE_REQUIREMENT");
      });

      it("preparation task proposed", () => {
        expect(stages.simulation.postStateSummary.addedTaskTitles).toEqual([
          "Source a red car for Scene 18",
        ]);
      });

      it("shoot-day/call-sheet impact surfaced", () => {
        expect(affectedOf(stages.analysis, "SHOOT_DAY")).toEqual([shootDays.tuesday]);
        expect(affectedOf(stages.analysis, "CALL_SHEET")).toEqual([callSheets.tuesday]);
      });

      it("duplicate replay does not create duplicate requirement/task", () => {
        const redCars = stages.stateAfter.requirements.filter(
          (requirement) => requirement.name === "red car",
        );
        const tasks = stages.stateAfter.tasks.filter(
          (task) => task.title === "Source a red car for Scene 18",
        );
        expect(redCars).toHaveLength(1);
        expect(tasks).toHaveLength(1);
        expect(stages.replay).toMatchObject({
          applied: false,
          replayed: true,
          productionVersion: stages.applied.productionVersion,
        });
        expect(stages.resimulated.postStateSummary.addedRequirementNames).toEqual([]);
        expect(stages.resimulated.postStateSummary.addedTaskTitles).toEqual([]);
      });

      itHoldsTheApprovalBoundary(() => stages);

      it("the requirement is wired to the scene with a real ID", () => {
        const requirement = stages.stateAfter.requirements.find(
          (candidate) => candidate.name === "red car",
        );
        expect(requirement?.id).not.toMatch(/^SIM-/u);
        expect(
          stages.stateAfter.scenes.find((scene) => scene.id === scenes.s18)?.requirementIds,
        ).toEqual([requirement?.id]);
      });
    });
  });
};
