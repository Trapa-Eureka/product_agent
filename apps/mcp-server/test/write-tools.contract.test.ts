import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import {
  createCreateProposal,
  createDecideProposal,
  createSubmitChangeRequest,
} from "@pca/application";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds, approver } from "@pca/test-support";

import { createProductionChangeServer, createWriteToolHandlers, readToolError } from "../src";

/**
 * Write tool contracts (MCP.md §7, §10). Approval is made through the use
 * case, never through a tool, because there is no approve tool: an agent
 * cannot grant itself permission. Every refusal proves the production did
 * not change.
 */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const NOW = "2026-09-10T11:05:00.000Z";

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
let approve: (proposalId: string) => Promise<string>;
let propose: (operations: ProposedOperation[]) => Promise<string>;

const applyArgs = (overrides: Record<string, unknown> = {}) => ({
  productionId: DEMO,
  proposalId: "P-1",
  approvalId: "A-1",
  expectedProductionVersion: 1,
  idempotencyKey: "apply:P-1:first",
  ...overrides,
});

const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name: "apply_approved_proposal", arguments: args });
  const error = readToolError(result);
  return error === null ? (result.structuredContent as Record<string, unknown>) : { error };
};

const untouched = async (): Promise<void> => {
  const state = await store.productions.loadState(DEMO);
  expect(state?.production.version).toBe(1);
  expect(state?.shootDays[0]?.sceneIds).toEqual([scenes.s07, scenes.s12]);
};

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
  propose = async (operations) => {
    const baseProductionVersion = (await store.productions.loadState(DEMO))!.production.version;
    const created = await create({
      productionId: DEMO,
      changeRequestId: "CR-1",
      baseProductionVersion,
      operations,
      summary: "remedy",
      proposedBy: "agent",
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.id;
  };
  approve = async (proposalId) => {
    const decided = await decide({
      productionId: DEMO,
      proposalId,
      decision: "APPROVE",
      decidedBy: approver("jinho@example.test"),
    });
    if (!decided.ok) throw new Error(decided.error.message);
    return decided.value.approval.id;
  };

  const { server } = createProductionChangeServer({
    handlers: createWriteToolHandlers(deps),
    context: { actor: { type: "AGENT", id: "executor-agent" }, allowedProductionIds: [DEMO] },
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

describe("successful application", () => {
  it("applies an approved proposal, records the acting identity, and answers in the documented shape", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    const result = await call(applyArgs({ approvalId }));

    expect(result).toEqual({
      applied: true,
      replayed: false,
      productionVersion: 2,
      affectedEntityIds: [
        cast.sarah,
        callSheets.friday,
        callSheets.monday,
        shootDays.friday,
        shootDays.monday,
      ],
      proposalStatus: "APPLIED",
    });
    const state = await store.productions.loadState(DEMO);
    expect(state?.shootDays.map((day) => day.sceneIds)).toEqual([
      [],
      [scenes.s22, scenes.s07, scenes.s12],
      [scenes.s18],
    ]);
    const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
    expect(event).toMatchObject({
      action: "PROPOSAL_APPLIED",
      actorType: "SYSTEM",
      actorId: "executor-agent",
    });
  });

  it("answers a replayed idempotency key from its record without touching the production again", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    const first = await call(applyArgs({ approvalId }));
    const auditCount = (await store.auditEvents.list(DEMO)).length;
    const second = await call(applyArgs({ approvalId }));

    expect(second).toEqual({ ...first, applied: false, replayed: true });
    expect((await store.productions.loadState(DEMO))?.production.version).toBe(2);
    expect((await store.auditEvents.list(DEMO)).length).toBe(auditCount);
  });
});

describe("no approval = no mutation", () => {
  it("refuses without any approval record", async () => {
    await propose(golden1);
    expect((await call(applyArgs()))["error"]).toMatchObject({ code: "APPROVAL_REQUIRED" });
    await untouched();
  });

  it("refuses an approval that belongs to a different proposal", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    await propose(golden1);
    const result = await call(applyArgs({ proposalId: "P-2", approvalId }));
    expect(result["error"]).toMatchObject({
      code: "APPROVAL_MISMATCH",
      expected: "P-2",
      actual: "P-1",
    });
    await untouched();
  });

  it("refuses an invalid proposal even when approval is attempted", async () => {
    await propose([golden1[0]!, { ...golden1[1]!, sceneIds: [scenes.s07] } as ProposedOperation]);
    expect((await call(applyArgs()))["error"]).toMatchObject({ code: "APPROVAL_REQUIRED" });
    await untouched();
  });
});

describe("freshness and identity", () => {
  it("refuses a stale expected version before touching anything", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    const result = await call(applyArgs({ approvalId, expectedProductionVersion: 7 }));
    expect(result["error"]).toMatchObject({
      code: "PRODUCTION_VERSION_MISMATCH",
      expected: "7",
      actual: "1",
    });
    await untouched();
  });

  it("refuses a proposal edited after approval", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    const stored = (await store.proposals.findById(DEMO, "P-1"))!;
    await store.proposals.save({ ...stored, operations: [golden1[1]!] });
    expect((await call(applyArgs({ approvalId })))["error"]).toMatchObject({
      code: "PROPOSAL_INVALID",
    });
    await untouched();
  });

  it("refuses an idempotency key reused for different work", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    await call(applyArgs({ approvalId }));
    await propose([{ type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday }]);
    const result = await call(
      applyArgs({ proposalId: "P-2", approvalId: "A-2", expectedProductionVersion: 2 }),
    );
    expect(result["error"]).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("boundary", () => {
  it("refuses a production outside the server's allow-list before any handler runs", async () => {
    const result = await call(applyArgs({ productionId: "PROD-OTHER" }));
    expect(result["error"]).toMatchObject({ code: "TOOL_UNAUTHORIZED", actual: "PROD-OTHER" });
  });

  it("refuses a request missing any of the binding fields", async () => {
    for (const field of ["approvalId", "expectedProductionVersion", "idempotencyKey"]) {
      const rest: Record<string, unknown> = { ...applyArgs() };
      delete rest[field];
      expect((await call(rest))["error"]).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("refuses an apply that tries to smuggle in its own operations", async () => {
    await propose(golden1);
    const approvalId = await approve("P-1");
    const result = await call(
      applyArgs({
        approvalId,
        operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday }],
      }),
    );
    expect(result["error"]).toMatchObject({ code: "INVALID_INPUT" });
    await untouched();
  });
});
