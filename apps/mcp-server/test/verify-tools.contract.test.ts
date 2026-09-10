import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import {
  createApplyApprovedProposal,
  createCreateProposal,
  createDecideProposal,
  createSubmitChangeRequest,
} from "@pca/application";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds } from "@pca/test-support";

import { createProductionChangeServer, createVerifyToolHandlers, readToolError } from "../src";

/** Verification tool contracts (MCP.md §8, §10) through a real MCP client. */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const NOW = "2026-09-10T11:05:30.000Z";

const golden1: ProposedOperation[] = [
  {
    type: "RECORD_CAST_UNAVAILABILITY",
    castId: cast.sarah,
    unavailable: onDay(DEMO_MOVIE_DATES.friday),
  },
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
let proposeOnly: () => Promise<string>;
let runThroughApply: () => Promise<string>;

const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name: "verify_applied_proposal", arguments: args });
  const error = readToolError(result);
  return error === null ? (result.structuredContent as Record<string, unknown>) : { error };
};

type Check = { name: string; passed: boolean; detail?: string };

beforeEach(async () => {
  store = createMemoryStore({ now: () => NOW });
  await store.productions.save(createDemoMovie());
  const deps = { repositories: store, clock: fixedClock(NOW), ids: sequentialIds() };
  await createSubmitChangeRequest(deps)({
    productionId: DEMO,
    rawText: "Sarah cannot shoot Friday.",
    change: {
      type: "CAST_UNAVAILABLE",
      castId: cast.sarah,
      unavailable: onDay(DEMO_MOVIE_DATES.friday),
    },
    createdBy: "coordinator@example.test",
  });
  const create = createCreateProposal(deps);
  const decide = createDecideProposal(deps);
  const apply = createApplyApprovedProposal(deps);

  proposeOnly = async () => {
    const created = await create({
      productionId: DEMO,
      changeRequestId: "CR-1",
      baseProductionVersion: 1,
      operations: golden1,
      summary: "remedy",
      proposedBy: "agent",
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.id;
  };
  runThroughApply = async () => {
    const proposalId = await proposeOnly();
    const decided = await decide({
      productionId: DEMO,
      proposalId,
      decision: "APPROVE",
      decidedBy: "jinho@example.test",
    });
    if (!decided.ok) throw new Error(decided.error.message);
    const applied = await apply({
      productionId: DEMO,
      proposalId,
      approvalId: decided.value.approval.id,
      expectedProductionVersion: 1,
      idempotencyKey: `apply:${proposalId}:first`,
    });
    if (!applied.ok) throw new Error(applied.error.message);
    return proposalId;
  };

  const { server } = createProductionChangeServer({
    handlers: createVerifyToolHandlers(deps),
    context: { actor: { type: "AGENT", id: "verifier-agent" }, allowedProductionIds: [DEMO] },
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

afterEach(() => cleanup());

describe("verify_applied_proposal", () => {
  it("is advertised, and passes every named check after GOLDEN-1 is applied", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["verify_applied_proposal"]);

    const proposalId = await runThroughApply();
    const result = await call({ productionId: DEMO, proposalId });

    expect(Object.keys(result).sort()).toEqual(["checks", "success"]);
    expect(result["success"]).toBe(true);
    expect((result["checks"] as Check[]).map((check) => [check.name, check.passed])).toEqual([
      ["1. Sarah recorded unavailable 2026-09-18 to 2026-09-18", true],
      ["2. Scene 07, Scene 12 moved to 2026-09-21", true],
      ["3. Call sheet CS-2026-09-18 is a draft", true],
      ["4. Call sheet CS-2026-09-21 is a draft", true],
      ["No scene requiring Sarah remains scheduled while Sarah is unavailable", true],
      ["Production satisfies every invariant", true],
      ["Production version advanced past the proposal's base", true],
      ["Proposal is marked APPLIED", true],
      ["Apply was audited", true],
    ]);
    expect((await store.auditEvents.list(DEMO, { limit: 1 }))[0]?.action).toBe("PROPOSAL_VERIFIED");
  });

  it("names the single failed check when the write landed without its bookkeeping", async () => {
    const proposalId = await runThroughApply();
    const stored = (await store.proposals.findById(DEMO, proposalId))!;
    await store.proposals.save({ ...stored, status: "APPROVED" });

    const result = await call({ productionId: DEMO, proposalId });
    expect(result["success"]).toBe(false);
    const failed = (result["checks"] as Check[]).filter((check) => !check.passed);
    expect(failed.map((check) => check.name)).toEqual(["Proposal is marked APPLIED"]);
    expect(failed[0]?.detail).toContain("bookkeeping did not");
    expect((await store.auditEvents.list(DEMO, { limit: 1 }))[0]?.action).toBe(
      "PROPOSAL_VERIFICATION_FAILED",
    );
  });

  it("reports an un-applied proposal honestly rather than as an error", async () => {
    const proposalId = await proposeOnly();
    const result = await call({ productionId: DEMO, proposalId });
    expect(result["success"]).toBe(false);
    expect(
      (result["checks"] as Check[]).filter((check) => check.passed).map((check) => check.name),
    ).toEqual(["Production satisfies every invariant"]);
  });

  it("never changes the production", async () => {
    const proposalId = await runThroughApply();
    const before = await store.productions.loadState(DEMO);
    await call({ productionId: DEMO, proposalId });
    expect(await store.productions.loadState(DEMO)).toEqual(before);
  });

  it("refuses an unknown proposal, a production outside the allow-list, and malformed input", async () => {
    expect((await call({ productionId: DEMO, proposalId: "P-404" }))["error"]).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      actual: "P-404",
    });
    expect((await call({ productionId: "PROD-OTHER", proposalId: "P-1" }))["error"]).toMatchObject({
      code: "TOOL_UNAUTHORIZED",
    });
    expect((await call({ productionId: DEMO }))["error"]).toMatchObject({ code: "INVALID_INPUT" });
  });
});
