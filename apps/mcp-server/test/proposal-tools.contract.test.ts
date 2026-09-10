import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSubmitChangeRequest } from "@pca/application";
import { computeProposalDigest } from "@pca/domain";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds } from "@pca/test-support";

import { createProductionChangeServer, createProposalToolHandlers, readToolError } from "../src";

/** Proposal tool contracts (MCP.md §6, §10) through a real MCP client. */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, scenes, shootDays } = DEMO_MOVIE_IDS;
const NOW = "2026-09-10T11:04:00.000Z";

const golden1 = [
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

const createArgs = {
  productionId: DEMO,
  changeRequestId: "CR-1",
  baseProductionVersion: 1,
  operations: golden1,
  summary: "Move the Warehouse scenes to Monday.",
};

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
const errorOf = async (name: string, args: Record<string, unknown>) =>
  (await call(name, args))["error"] as Record<string, unknown> | undefined;

beforeAll(async () => {
  store = createMemoryStore({ now: () => NOW });
  await store.productions.save(createDemoMovie());
  const ids = sequentialIds();
  const clock = fixedClock(NOW);
  await createSubmitChangeRequest({ repositories: store, clock, ids })({
    productionId: DEMO,
    rawText: "Sarah cannot shoot Friday.",
    change: {
      type: "CAST_UNAVAILABLE",
      castId: cast.sarah,
      unavailable: onDay(DEMO_MOVIE_DATES.friday),
    },
    createdBy: "coordinator@example.test",
  });

  const { server } = createProductionChangeServer({
    handlers: createProposalToolHandlers({ repositories: store, clock, ids }),
    context: { actor: { type: "AGENT", id: "planner-agent" }, allowedProductionIds: "*" },
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

describe("advertisement and refusals", () => {
  it("lists exactly the two proposal tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["create_proposal", "get_proposal"]);
  });

  it("refuses an unknown production on both tools", async () => {
    expect(
      (await errorOf("create_proposal", { ...createArgs, productionId: "PROD-GHOST" }))?.["code"],
    ).toBe("ENTITY_NOT_FOUND");
    expect(
      (await errorOf("get_proposal", { productionId: "PROD-GHOST", proposalId: "P-1" }))?.["code"],
    ).toBe("ENTITY_NOT_FOUND");
  });

  it("refuses malformed input before any handler runs", async () => {
    expect((await errorOf("create_proposal", { ...createArgs, operations: [] }))?.["code"]).toBe(
      "INVALID_INPUT",
    );
    expect((await errorOf("get_proposal", { productionId: DEMO }))?.["code"]).toBe("INVALID_INPUT");
  });

  it("refuses a change request the production does not have, and a stale base version", async () => {
    expect(
      (await errorOf("create_proposal", { ...createArgs, changeRequestId: "CR-404" }))?.["code"],
    ).toBe("ENTITY_NOT_FOUND");
    expect(
      await errorOf("create_proposal", { ...createArgs, baseProductionVersion: 9 }),
    ).toMatchObject({
      code: "PRODUCTION_VERSION_MISMATCH",
      expected: "9",
      actual: "1",
    });
  });
});

describe("create_proposal", () => {
  it("seals the operations under the server's acting identity and audits it", async () => {
    const result = await call("create_proposal", createArgs);
    const proposal = result["proposal"] as Record<string, unknown>;

    expect(proposal).toMatchObject({
      id: "P-1",
      changeRequestId: "CR-1",
      baseProductionVersion: 1,
      validationStatus: "VALID",
      status: "AWAITING_APPROVAL",
      createdAt: NOW,
    });
    expect(proposal["digest"]).toBe(computeProposalDigest(proposal as never));

    const [event] = await store.auditEvents.list(DEMO, { limit: 1 });
    expect(event).toMatchObject({
      action: "PROPOSAL_CREATED",
      actorType: "AGENT",
      actorId: "planner-agent",
      entityId: "P-1",
    });
  });

  it("persists an invalid plan as a draft that shows why", async () => {
    // Record the fact but move only Scene 07: Scene 12 stays conflicted.
    const result = await call("create_proposal", {
      ...createArgs,
      operations: [golden1[0], { ...golden1[1], sceneIds: [scenes.s07] }],
      summary: "Move only Scene 07 and leave Scene 12 behind.",
    });
    const proposal = result["proposal"] as Record<string, unknown>;
    expect(proposal).toMatchObject({ status: "DRAFT", validationStatus: "INVALID" });
  });
});

describe("get_proposal", () => {
  it("returns the stored proposal with its digest and status", async () => {
    const created = (await call("create_proposal", createArgs))["proposal"] as Record<
      string,
      unknown
    >;
    const fetched = (await call("get_proposal", { productionId: DEMO, proposalId: created["id"] }))[
      "proposal"
    ];
    expect(fetched).toEqual(created);
  });

  it("refuses an unknown proposal, with the next step named", async () => {
    expect(
      await errorOf("get_proposal", { productionId: DEMO, proposalId: "P-404" }),
    ).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      actual: "P-404",
    });
  });
});
