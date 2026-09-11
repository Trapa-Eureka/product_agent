import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCreateProposal, createSubmitChangeRequest } from "@pca/application";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds } from "@pca/test-support";

import {
  createAnalysisToolHandlers,
  createProductionChangeServer,
  memoryLogger,
  readToolError,
} from "../src";

/**
 * Analysis tool contracts (MCP.md §5, §10) through a real MCP client. The
 * engines behind these tools have their own exact-set tests; what is pinned
 * here is that each tool advertises, validates, authorises, and answers in
 * the documented shape, and that none of them writes production state.
 */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday } = DEMO_MOVIE_DATES;

const sarahOnFriday = { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onDay(friday) };
const golden1 = [
  { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.monday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
];

let store: MemoryStore;
let client: Client;
let cleanup: () => Promise<void>;

const call = async (
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: args });
  const error = readToolError(result);
  return error === null ? (result.structuredContent as Record<string, unknown>) : { error };
};
const errorCode = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
  ((await call(name, args))["error"] as { code: string } | undefined)?.code;

beforeAll(async () => {
  store = createMemoryStore({ now: () => "2026-09-10T11:04:00.000Z" });
  await store.productions.save(createDemoMovie());
  const deps = { repositories: store, clock: fixedClock(), ids: sequentialIds() };
  await createSubmitChangeRequest(deps)({
    productionId: DEMO,
    rawText: "Sarah cannot shoot Friday.",
    change: sarahOnFriday as never,
    createdBy: "coordinator@example.test",
  });
  await createCreateProposal(deps)({
    productionId: DEMO,
    changeRequestId: "CR-1",
    baseProductionVersion: 1,
    operations: golden1 as never,
    summary: "Move the Warehouse scenes to Monday.",
    proposedBy: "agent",
  });

  const { server } = createProductionChangeServer({
    handlers: createAnalysisToolHandlers({ repositories: store }),
    context: { actor: { type: "AGENT", id: "test-agent" }, allowedProductionIds: "*" },
    ids: sequentialIds(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(() => cleanup());

describe("advertisement and shared refusals", () => {
  it("lists exactly the four analysis tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "analyze_change_impact",
      "generate_schedule_candidates",
      "simulate_proposal",
      "validate_proposal",
    ]);
  });

  it.each([
    ["analyze_change_impact", { change: sarahOnFriday }],
    ["generate_schedule_candidates", { sceneIds: [scenes.s07] }],
    ["simulate_proposal", { baseProductionVersion: 1, operations: golden1 }],
    ["validate_proposal", { proposalId: "P-1" }],
  ])("%s refuses an unknown production", async (name, args) => {
    expect(await errorCode(name, { productionId: "PROD-GHOST", ...args })).toBe("ENTITY_NOT_FOUND");
  });

  it.each([
    ["analyze_change_impact", { change: { type: "CAST_FIRED", castId: cast.sarah } }],
    ["generate_schedule_candidates", { sceneIds: [] }],
    [
      "simulate_proposal",
      { baseProductionVersion: 1, operations: [{ type: "DELETE_SCENE", sceneId: scenes.s07 }] },
    ],
    ["validate_proposal", {}],
  ])("%s refuses malformed input", async (name, args) => {
    expect(await errorCode(name, { productionId: DEMO, ...args })).toBe("INVALID_INPUT");
  });
});

describe("analyze_change_impact", () => {
  it("returns the GOLDEN-1 impact set with the version it was computed against", async () => {
    const result = await call("analyze_change_impact", {
      productionId: DEMO,
      change: sarahOnFriday,
    });
    expect(result["productionVersion"]).toBe(1);
    expect(result["affectedEntityIds"]).toEqual([
      cast.john,
      callSheets.friday,
      DEMO_MOVIE_IDS.locations.warehouse,
      scenes.s07,
      scenes.s12,
      shootDays.friday,
      "T-001",
      "T-002",
      "T-003",
    ]);
    expect((result["conflicts"] as { code: string }[]).map((conflict) => conflict.code)).toEqual([
      "CAST_UNAVAILABLE_ON_SHOOT_DAY",
      "CAST_UNAVAILABLE_ON_SHOOT_DAY",
    ]);
    // The DESIGN.md §3 impact panel is REST-only (TASK-503); the strict MCP
    // output schema has no room for it, so the agent sees only these four keys.
    expect(Object.keys(result).sort()).toEqual([
      "affectedEntityIds",
      "conflicts",
      "impacts",
      "productionVersion",
    ]);
  });

  it("refuses a change naming an entity the production does not have, with the lookup tool", async () => {
    const result = await call("analyze_change_impact", {
      productionId: DEMO,
      change: { ...sarahOnFriday, castId: "CAST-GHOST" },
    });
    expect(result["error"]).toMatchObject({ code: "ENTITY_NOT_FOUND", actual: "CAST-GHOST" });
    expect((result["error"] as { nextStep: string }).nextStep).toContain("find_cast");
  });
});

describe("generate_schedule_candidates", () => {
  it("offers Monday and Tuesday for the Warehouse scenes and refuses Friday with a reason", async () => {
    const result = await call("generate_schedule_candidates", {
      productionId: DEMO,
      sceneIds: [scenes.s07, scenes.s12],
    });
    expect((result["candidates"] as { date: string }[]).map((candidate) => candidate.date)).toEqual(
      [monday, DEMO_MOVIE_DATES.tuesday],
    );
    expect((result["rejected"] as { date: string; reasons: string[] }[])[0]).toEqual({
      shootDayId: shootDays.friday,
      date: friday,
      reasons: ["A moving scene is already scheduled on 2026-09-18."],
    });
  });

  it("honours excluded dates", async () => {
    const result = await call("generate_schedule_candidates", {
      productionId: DEMO,
      sceneIds: [scenes.s07],
      excludeDates: [monday],
    });
    expect((result["candidates"] as { date: string }[]).map((candidate) => candidate.date)).toEqual(
      [DEMO_MOVIE_DATES.tuesday],
    );
  });
});

describe("simulate_proposal", () => {
  it("returns a valid would-be world for the GOLDEN-1 remedy without writing anything", async () => {
    const result = await call("simulate_proposal", {
      productionId: DEMO,
      baseProductionVersion: 1,
      operations: golden1,
    });
    expect(result["valid"]).toBe(true);
    expect(
      (result["resolvedConflicts"] as { entityId: string }[]).map((conflict) => conflict.entityId),
    ).toEqual([scenes.s07, scenes.s12]);
    expect(
      (result["postStateSummary"] as { staleCallSheetIds: string[] }).staleCallSheetIds,
    ).toEqual([callSheets.friday, callSheets.monday]);
    expect((await store.productions.loadState(DEMO))?.production.version).toBe(1);
  });

  it("TASK-911: a bare MOVE_SCENES that leaves the changed days' call sheets published is invalid", async () => {
    // The review's reproduction: move Scene 18 by hand, no MARK_CALL_SHEET_STALE, and every sheet stayed published.
    const result = await call("simulate_proposal", {
      productionId: DEMO,
      baseProductionVersion: 1,
      operations: [
        {
          type: "MOVE_SCENES",
          sceneIds: [scenes.s18],
          fromShootDayId: shootDays.tuesday,
          toShootDayId: shootDays.monday,
        },
      ],
    });
    expect(result["valid"]).toBe(false);
    expect(
      (result["conflicts"] as { code: string; entityId: string }[]).map((conflict) => [
        conflict.code,
        conflict.entityId,
      ]),
    ).toEqual([
      ["CALL_SHEET_PUBLISHED_FOR_CHANGED_SHOOT_DAY", callSheets.monday],
      ["CALL_SHEET_PUBLISHED_FOR_CHANGED_SHOOT_DAY", callSheets.tuesday],
    ]);
  });

  it("refuses a base version that is no longer current", async () => {
    const result = await call("simulate_proposal", {
      productionId: DEMO,
      baseProductionVersion: 7,
      operations: golden1,
    });
    expect(result["error"]).toMatchObject({
      code: "PRODUCTION_VERSION_MISMATCH",
      expected: "7",
      actual: "1",
    });
  });
});

describe("validate_proposal", () => {
  it("confirms the sealed proposal in the documented shape, and nothing more", async () => {
    const result = await call("validate_proposal", { productionId: DEMO, proposalId: "P-1" });
    expect(Object.keys(result).sort()).toEqual([
      "baseProductionVersion",
      "conflicts",
      "productionVersion",
      "valid",
      "warnings",
    ]);
    expect(result).toMatchObject({
      valid: true,
      productionVersion: 1,
      baseProductionVersion: 1,
      conflicts: [],
    });
  });

  it("refuses an unknown proposal", async () => {
    expect(await errorCode("validate_proposal", { productionId: DEMO, proposalId: "P-404" })).toBe(
      "ENTITY_NOT_FOUND",
    );
  });
});

describe("analyze_change_impact timing (TASK-804)", () => {
  it("logs a dependency_analysis line, separate from the tool_call line every tool already logs", async () => {
    const logger = memoryLogger();
    const { server } = createProductionChangeServer({
      handlers: createAnalysisToolHandlers({ repositories: store, logger }),
      context: { actor: { type: "AGENT", id: "test-agent" }, allowedProductionIds: "*" },
      ids: sequentialIds(),
      logger,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const timingClient = new Client({ name: "timing-client", version: "0.0.0" });
    await timingClient.connect(clientTransport);

    await timingClient.callTool({
      name: "analyze_change_impact",
      arguments: { productionId: DEMO, change: sarahOnFriday },
    });

    await timingClient.close();
    await server.close();

    const events = logger.lines.map((line) => line.event);
    expect(events).toContain("dependency_analysis");
    expect(events).toContain("tool_call");
    const analysis = logger.lines.find((line) => line.event === "dependency_analysis");
    expect(typeof analysis?.fields["durationMs"]).toBe("number");
  });
});
