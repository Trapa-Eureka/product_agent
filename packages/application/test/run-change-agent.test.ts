import { beforeEach, describe, expect, it } from "vitest";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { createRuleModelAdapter } from "@pca/rule-model";
import {
  createFakeModelAdapter,
  fixedClock,
  onDay,
  sequentialIds,
  withLocationUnavailable,
} from "@pca/test-support";

import type { LogFields, LogLevel, ModelPort } from "../src";
import {
  createRunChangeAgent,
  guardModelPort,
  toProposalSummary,
  type RunChangeAgent,
} from "../src";

/** Collects log lines instead of printing them, so a test can assert on shape. */
const recordingLogger = (): {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[];
  log: (level: LogLevel, event: string, fields?: LogFields) => void;
} => {
  const lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  return {
    lines,
    log: (level, event, fields = {}) => {
      lines.push({ level, event, fields });
    },
  };
};

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;
const NOW = "2026-09-10T03:00:00.000Z";

describe("runChangeAgent", () => {
  let store: MemoryStore;
  let run: RunChangeAgent;

  const agent = (model: ModelPort = createRuleModelAdapter()) =>
    createRunChangeAgent({
      repositories: store,
      model: guardModelPort(model, { timeoutMs: 200 }),
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });

  const unchanged = async (): Promise<void> => {
    const state = await store.productions.loadState(DEMO);
    expect(state?.production.version).toBe(1);
    expect(state?.shootDays[0]?.sceneIds).toEqual([scenes.s07, scenes.s12]);
    expect(state?.castMembers.find((member) => member.id === cast.sarah)?.unavailable).toEqual([]);
  };

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    run = agent();
  });

  it("GOLDEN-1: proposes the fact, the move to the ranked day, and the stale marks, and writes nothing", async () => {
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "coordinator@example.test",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");

    const outcome = result.value;
    expect(outcome.proposal.operations).toEqual([
      { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
      {
        type: "MOVE_SCENES",
        sceneIds: [scenes.s07, scenes.s12],
        fromShootDayId: shootDays.friday,
        toShootDayId: shootDays.tuesday,
      },
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
    ]);
    expect(outcome.proposal).toMatchObject({
      status: "AWAITING_APPROVAL",
      validationStatus: "VALID",
      changeRequestId: "CR-1",
    });
    expect(outcome.ranked.map((entry) => [entry.rank, entry.shootDayId])).toEqual([
      [1, shootDays.tuesday],
      [2, shootDays.monday],
    ]);
    expect(outcome.explanation.headline).toBe(
      "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    );
    expect(outcome.explanation.effects.map((effect) => effect.text)).toContain(
      "resolves Sarah conflict on Scene 07 and Scene 12",
    );
    expect(outcome.explanation.narrative).toContain("resolves 2 existing conflicts");
    expect(outcome.proposal.summary).toBe(toProposalSummary(outcome.explanation));
    expect(outcome.proposal.summary).toContain(
      "\nOperations\n- record Sarah unavailable Fri Sep 18",
    );
    await unchanged();
  });

  it("ranks Tuesday first because Monday carries John's warning, and the summary explains", async () => {
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "c",
    });
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(result.value.ranked[1]?.reason).toContain("John is already required");
  });

  it("tells the audit story: submitted, analysis requested, analysis completed, proposed", async () => {
    await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "c",
      correlationId: "corr-1",
    });
    const events = (await store.auditEvents.list(DEMO)).reverse();
    expect(events.map((event) => [event.actorType, event.action])).toEqual([
      ["USER", "CHANGE_REQUEST_SUBMITTED"],
      ["AGENT", "ANALYSIS_REQUESTED"],
      ["SYSTEM", "ANALYSIS_COMPLETED"],
      ["AGENT", "PROPOSAL_CREATED"],
    ]);
    expect(events[2]?.metadata).toMatchObject({ conflictCount: 2 });
    expect(events.every((event) => event.correlationId === "corr-1")).toBe(true);
  });

  it("GOLDEN-2: records the location fact and moves the Warehouse scenes", async () => {
    const result = await run({
      productionId: DEMO,
      text: "The warehouse is unavailable Friday.",
      requestedBy: "c",
    });
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(result.value.proposal.operations[0]).toEqual({
      type: "RECORD_LOCATION_UNAVAILABILITY",
      locationId: locations.warehouse,
      unavailable: onDay(friday),
    });
    expect(result.value.proposal.operations[1]).toMatchObject({
      type: "MOVE_SCENES",
      sceneIds: [scenes.s07, scenes.s12],
    });
    await unchanged();
  });

  it("GOLDEN-3: proposes the requirement, a preparation task, and the Tuesday stale mark", async () => {
    const result = await run({
      productionId: DEMO,
      text: "Scene 18 now needs a red car.",
      requestedBy: "c",
    });
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(result.value.proposal.operations).toEqual([
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
      { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
    ]);
    expect(result.value.candidates).toEqual([]);
    await unchanged();
  });

  it("hands ambiguity back before recording anything", async () => {
    const state = createDemoMovie();
    await store.productions.save({
      ...state,
      castMembers: [
        ...state.castMembers,
        { id: "CAST-SARAH-2", productionId: DEMO, name: "Sarah", unavailable: [] },
      ],
    });
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "c",
    });
    expect(result.ok && result.value.kind).toBe("NEEDS_RESOLUTION");
    expect(await store.changeRequests.findById(DEMO, "CR-1")).toBeNull();
    expect(await store.auditEvents.list(DEMO)).toEqual([]);
  });

  it("accepts the change chosen in the resolution step and skips interpretation", async () => {
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      requestedBy: "c",
    });
    expect(result.ok && result.value.kind).toBe("PROPOSED");
  });

  it("records the fact alone when no scene is affected, as a valid proposal", async () => {
    const result = await run({
      productionId: DEMO,
      text: "Mike cannot shoot Friday.",
      requestedBy: "c",
    });
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(result.value.proposal.operations).toEqual([
      { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.mike, unavailable: onDay(friday) },
    ]);
    expect(result.value.proposal.validationStatus).toBe("VALID");
  });

  it("reports NO_CANDIDATE, with every refusal, when no day can take the scenes", async () => {
    const blocked = withLocationUnavailable(
      withLocationUnavailable(createDemoMovie(), locations.warehouse, onDay(monday)),
      locations.warehouse,
      onDay(tuesday),
    );
    await store.productions.save(blocked);
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "c",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "NO_CANDIDATE")
      throw new Error("expected NO_CANDIDATE");
    expect(result.value.rejected.map((day) => day.date)).toEqual([friday, monday, tuesday]);
    expect(await store.changeRequests.findById(DEMO, "CR-1")).not.toBeNull();
    expect(await store.proposals.listByStatus(DEMO, "AWAITING_APPROVAL")).toEqual([]);
  });

  it("TASK-904: a multi-day unavailability never proposes a day inside its own range", async () => {
    // Friday through Monday: Monday was a valid candidate against the stored
    // state, but the fact being recorded makes it invalid. Before the fix the
    // generator read the stored state, could rank Monday, and the proposal
    // failed simulation as INVALID although Tuesday was free.
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday through Monday.",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: cast.sarah,
        unavailable: { start: friday, end: monday },
      },
      requestedBy: "c",
    });
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");

    expect(result.value.candidates.map((day) => day.date)).toEqual([tuesday]);
    expect(result.value.rejected.find((day) => day.date === monday)?.reasons.join(" ")).toContain(
      `Sarah is unavailable on ${monday}`,
    );
    expect(result.value.proposal.validationStatus).toBe("VALID");
    expect(result.value.proposal.operations).toContainEqual({
      type: "MOVE_SCENES",
      sceneIds: [scenes.s07, scenes.s12],
      fromShootDayId: shootDays.friday,
      toShootDayId: shootDays.tuesday,
    });
    await unchanged();
  });

  it("TASK-904: an unavailability covering every alternative reports NO_CANDIDATE, not an invalid plan", async () => {
    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday through Tuesday.",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: cast.sarah,
        unavailable: { start: friday, end: tuesday },
      },
      requestedBy: "c",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "NO_CANDIDATE")
      throw new Error(`expected NO_CANDIDATE, got ${result.ok ? result.value.kind : "error"}`);

    expect(result.value.rejected.map((day) => day.date)).toEqual([friday, monday, tuesday]);
    for (const date of [monday, tuesday]) {
      expect(result.value.rejected.find((day) => day.date === date)?.reasons.join(" ")).toContain(
        `Sarah is unavailable on ${date}`,
      );
    }
    expect(await store.proposals.listByStatus(DEMO, "AWAITING_APPROVAL")).toEqual([]);
    expect(await store.proposals.listByStatus(DEMO, "DRAFT")).toEqual([]);
    await unchanged();
  });

  it("reports NOTHING_TO_DO when the scene already has the requirement", async () => {
    const state = createDemoMovie();
    await store.productions.save({
      ...state,
      requirements: [
        ...state.requirements,
        {
          id: "REQ-009",
          productionId: DEMO,
          sceneId: scenes.s18,
          type: "PROP",
          name: "Red Car",
          status: "NEEDED",
        },
      ],
    });
    const result = await run({
      productionId: DEMO,
      text: "Scene 18 now needs a red car.",
      requestedBy: "c",
    });
    expect(result.ok && result.value.kind).toBe("NOTHING_TO_DO");
  });

  it("refuses an unsupported sentence without recording anything", async () => {
    const result = await run({ productionId: DEMO, text: "Make it better.", requestedBy: "c" });
    expect(!result.ok && result.error.code).toBe("UNSUPPORTED_CHANGE");
    expect(await store.auditEvents.list(DEMO)).toEqual([]);
  });

  it("still proposes when the model cannot rank or explain, falling back to data", async () => {
    const result = await agent(createFakeModelAdapter({ misbehave: "hang" }))({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) },
      requestedBy: "c",
    });
    if (!result.ok || result.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(result.value.ranked[0]?.reason).toContain("did not answer");
    expect(result.value.proposal.operations[1]).toMatchObject({ toShootDayId: shootDays.monday });
    expect(result.value.explanation.narrative).toBeUndefined();
    expect(result.value.explanation.operations).toHaveLength(7);
    expect(result.value.proposal.summary).toMatch(/^Move Scene 07 and Scene 12 from Fri Sep 18/);
  });
});

describe("runChangeAgent timing (TASK-804)", () => {
  it("logs model_call and dependency_analysis lines through the fused loop", async () => {
    const logger = recordingLogger();
    const store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    const run = createRunChangeAgent({
      repositories: store,
      model: guardModelPort(createRuleModelAdapter(), { timeoutMs: 200, logger }),
      clock: fixedClock(NOW),
      ids: sequentialIds(),
      logger,
    });

    const result = await run({
      productionId: DEMO,
      text: "Sarah cannot shoot Friday.",
      requestedBy: "coordinator@example.test",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);

    const events = logger.lines.map((line) => line.event);
    expect(events).toContain("model_call");
    expect(events).toContain("dependency_analysis");
    expect(logger.lines.filter((line) => line.event === "model_call")).not.toHaveLength(0);
    for (const line of logger.lines) {
      expect(typeof line.fields["durationMs"]).toBe("number");
    }
  });
});
