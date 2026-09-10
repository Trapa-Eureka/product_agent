import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore } from "@pca/memory-store";
import { onDay, sequentialIds, withCastUnavailable } from "@pca/test-support";

import { createProductionChangeServer, createReadToolHandlers, readToolError } from "../src";

/**
 * Read tool contracts (MCP.md §4, §10): for every tool, valid input, malformed
 * input, a cross-production ID, a missing entity, and a deterministic result,
 * through a real MCP client.
 */

const DEMO = DEMO_MOVIE_IDS.production;
const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;

let client: Client;
let cleanup: () => Promise<void>;

/** Structured output on success; the ToolError under `error` on failure. */
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
  const store = createMemoryStore();
  await store.productions.save(withCastUnavailable(createDemoMovie(), cast.sarah, onDay(monday)));
  const { server } = createProductionChangeServer({
    handlers: createReadToolHandlers({ repositories: store }),
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

describe("the nine read tools are all advertised", () => {
  it("lists exactly the read tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "find_cast",
      "find_location",
      "get_call_sheet",
      "get_cast_availability",
      "get_location_availability",
      "get_production",
      "get_scene",
      "get_schedule",
      "get_tasks",
    ]);
  });
});

describe("shared refusals", () => {
  it.each([
    ["get_production", {}],
    ["get_scene", { sceneId: scenes.s07 }],
    ["find_cast", { query: "Sarah" }],
    ["get_cast_availability", { castId: cast.sarah, from: friday, to: monday }],
    ["find_location", { query: "Warehouse" }],
    ["get_location_availability", { locationId: locations.warehouse, from: friday, to: monday }],
    ["get_schedule", {}],
    ["get_call_sheet", { shootDayId: shootDays.friday }],
    ["get_tasks", {}],
  ])("%s refuses an unknown production with ENTITY_NOT_FOUND", async (name, args) => {
    expect(await errorCode(name, { productionId: "PROD-GHOST", ...args })).toBe("ENTITY_NOT_FOUND");
  });

  it.each([
    ["get_production", { productionId: DEMO, extra: true }],
    ["get_scene", { productionId: DEMO }],
    ["find_cast", { productionId: DEMO }],
    ["get_cast_availability", { productionId: DEMO, castId: cast.sarah, from: monday, to: friday }],
    ["get_schedule", { productionId: DEMO, date: "Friday" }],
    ["get_tasks", { productionId: DEMO, relatedEntityType: "CAST_MEMBER", relatedEntityId: "x" }],
  ])("%s refuses malformed input with INVALID_INPUT", async (name, args) => {
    expect(await errorCode(name, args)).toBe("INVALID_INPUT");
  });
});

describe("get_production", () => {
  it("returns the production header", async () => {
    expect(await call("get_production", { productionId: DEMO })).toEqual({
      id: DEMO,
      name: "Demo Movie",
      timezone: "Asia/Manila",
      version: 1,
    });
  });
});

describe("get_scene", () => {
  it("returns the scene with its location, cast, requirements, and shoot day, by number", async () => {
    const result = await call("get_scene", { productionId: DEMO, sceneNumber: "07" });
    expect(result).toMatchObject({
      scene: { id: scenes.s07, sceneNumber: "07" },
      location: { id: locations.warehouse, name: "Warehouse" },
      scheduledShootDayId: shootDays.friday,
    });
    expect((result["requiredCast"] as { name: string }[]).map((member) => member.name)).toEqual([
      "Sarah",
      "John",
    ]);
    expect((result["requirements"] as { name: string }[]).map((r) => r.name)).toEqual(["crowbar"]);
  });

  it("finds the same scene by ID", async () => {
    const result = await call("get_scene", { productionId: DEMO, sceneId: scenes.s18 });
    expect(result).toMatchObject({ scene: { sceneNumber: "18" }, requirements: [] });
  });

  it("refuses an unknown scene, naming the lookup tool", async () => {
    const result = await call("get_scene", { productionId: DEMO, sceneNumber: "99" });
    expect(result["error"]).toMatchObject({ code: "ENTITY_NOT_FOUND", actual: "99" });
    expect((result["error"] as { nextStep: string }).nextStep).toContain("get_schedule");
  });
});

describe("find_cast and find_location", () => {
  it("resolves by a case-insensitive fragment of the name or role", async () => {
    expect(await call("find_cast", { productionId: DEMO, query: "sar" })).toEqual({
      candidates: [{ id: cast.sarah, name: "Sarah", roleName: "Nadia" }],
    });
    expect(await call("find_cast", { productionId: DEMO, query: "barista" })).toEqual({
      candidates: [{ id: cast.mike, name: "Mike", roleName: "Barista" }],
    });
  });

  it("returns every match, sorted, and leaves ambiguity to the caller", async () => {
    // "i" appears in Nadia, Emil, and Mike, so every cast member matches.
    const result = await call("find_cast", { productionId: DEMO, query: "i" });
    expect((result["candidates"] as { name: string }[]).map((c) => c.name)).toEqual([
      "John",
      "Mike",
      "Sarah",
    ]);
  });

  it("returns an empty list, not an error, when nothing matches", async () => {
    expect(await call("find_location", { productionId: DEMO, query: "Rooftop" })).toEqual({
      candidates: [],
    });
  });

  it("resolves a location", async () => {
    expect(await call("find_location", { productionId: DEMO, query: "WARE" })).toEqual({
      candidates: [{ id: locations.warehouse, name: "Warehouse" }],
    });
  });
});

describe("availability", () => {
  it("lists the blocked dates inside the window explicitly", async () => {
    expect(
      await call("get_cast_availability", {
        productionId: DEMO,
        castId: cast.sarah,
        from: friday,
        to: tuesday,
      }),
    ).toEqual({
      entityId: cast.sarah,
      from: friday,
      to: tuesday,
      unavailableDates: [monday],
    });
    expect(
      await call("get_location_availability", {
        productionId: DEMO,
        locationId: locations.apartment,
        from: friday,
        to: tuesday,
      }),
    ).toMatchObject({
      unavailableDates: [tuesday],
    });
  });

  it("returns an empty list for a free window", async () => {
    expect(
      await call("get_cast_availability", {
        productionId: DEMO,
        castId: cast.john,
        from: friday,
        to: tuesday,
      }),
    ).toMatchObject({
      unavailableDates: [],
    });
  });

  it("refuses an unknown cast member or location", async () => {
    expect(
      await errorCode("get_cast_availability", {
        productionId: DEMO,
        castId: "CAST-GHOST",
        from: friday,
        to: friday,
      }),
    ).toBe("ENTITY_NOT_FOUND");
    expect(
      await errorCode("get_location_availability", {
        productionId: DEMO,
        locationId: "LOC-GHOST",
        from: friday,
        to: friday,
      }),
    ).toBe("ENTITY_NOT_FOUND");
  });
});

describe("get_schedule", () => {
  it("returns every shoot day in date order with the production version", async () => {
    const result = await call("get_schedule", { productionId: DEMO });
    expect(result["productionVersion"]).toBe(1);
    expect((result["shootDays"] as { date: string }[]).map((day) => day.date)).toEqual([
      friday,
      monday,
      tuesday,
    ]);
  });

  it("narrows to one date", async () => {
    const result = await call("get_schedule", { productionId: DEMO, date: friday });
    expect((result["shootDays"] as { sceneIds: string[] }[]).map((day) => day.sceneIds)).toEqual([
      [scenes.s07, scenes.s12],
    ]);
  });

  it("returns the day holding a scene, and nothing for a date with no shoot day", async () => {
    const byScene = await call("get_schedule", { productionId: DEMO, sceneId: scenes.s22 });
    expect((byScene["shootDays"] as { id: string }[]).map((day) => day.id)).toEqual([
      shootDays.monday,
    ]);
    expect(await call("get_schedule", { productionId: DEMO, date: "2026-09-19" })).toMatchObject({
      shootDays: [],
    });
  });

  it("refuses an unknown scene", async () => {
    expect(await errorCode("get_schedule", { productionId: DEMO, sceneId: "S99" })).toBe(
      "ENTITY_NOT_FOUND",
    );
  });
});

describe("get_call_sheet", () => {
  it("returns the call sheet for a shoot day", async () => {
    expect(
      await call("get_call_sheet", { productionId: DEMO, shootDayId: shootDays.friday }),
    ).toMatchObject({
      callSheet: { id: callSheets.friday, status: "PUBLISHED" },
    });
  });

  it("refuses an unknown shoot day", async () => {
    expect(await errorCode("get_call_sheet", { productionId: DEMO, shootDayId: "SD-GHOST" })).toBe(
      "ENTITY_NOT_FOUND",
    );
  });
});

describe("get_tasks", () => {
  it("lists every task in ID order", async () => {
    const result = await call("get_tasks", { productionId: DEMO });
    expect((result["tasks"] as { id: string }[]).map((task) => task.id)).toEqual([
      "T-001",
      "T-002",
      "T-003",
      "T-004",
    ]);
  });

  it("narrows to one related entity", async () => {
    const result = await call("get_tasks", {
      productionId: DEMO,
      relatedEntityType: "SCENE",
      relatedEntityId: scenes.s07,
    });
    expect((result["tasks"] as { title: string }[]).map((task) => task.title)).toEqual([
      "Prep crowbar for Scene 07",
    ]);
  });

  it("refuses a type without an ID, with the fix named", async () => {
    const result = await call("get_tasks", { productionId: DEMO, relatedEntityType: "SCENE" });
    expect(result["error"]).toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("determinism", () => {
  it("answers identically on repeated calls", async () => {
    const first = await call("get_scene", { productionId: DEMO, sceneNumber: "07" });
    const second = await call("get_scene", { productionId: DEMO, sceneNumber: "07" });
    expect(second).toEqual(first);
  });
});
