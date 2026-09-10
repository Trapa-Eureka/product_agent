/* eslint-disable @typescript-eslint/require-await --
 * The handlers below are synchronous stand-ins. They are still `async` because
 * the ToolHandler type promises a Promise, and a stub that throws synchronously
 * would exercise a different code path than a real handler does.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fail, succeed } from "@pca/application";
import { MCP_TOOL_NAMES } from "@pca/contracts";
import { DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { sequentialIds } from "@pca/test-support";

import {
  createProductionChangeServer,
  memoryLogger,
  readToolError,
  type ServerContext,
  type ToolHandlers,
} from "../src";

/**
 * Foundation contract: everything the server guarantees regardless of which
 * tools are wired. Exercised through a real MCP client over an in-memory
 * transport, so what is asserted is what an agent would see.
 */

const DEMO = DEMO_MOVIE_IDS.production;

const context: ServerContext = {
  actor: { type: "AGENT", id: "test-agent" },
  allowedProductionIds: [DEMO],
};

describe("MCP server foundation", () => {
  let store: MemoryStore;
  let client: Client;
  let logger: ReturnType<typeof memoryLogger>;
  let cleanup: () => Promise<void>;

  /** A minimal, honest get_production handler so the plumbing has something to carry. */
  const handlers = (overrides: ToolHandlers = {}): ToolHandlers => ({
    get_production: async (input, call) => {
      const state = await store.productions.loadState(input.productionId);
      if (state === null) {
        return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
          correlationId: call.correlationId,
          nextStep: "Use a known production ID.",
        });
      }
      const { id, name, timezone, version } = state.production;
      return succeed({ id, name, timezone, version });
    },
    ...overrides,
  });

  const connect = async (toolHandlers: ToolHandlers, serverContext = context): Promise<void> => {
    logger = memoryLogger();
    const { server } = createProductionChangeServer({
      handlers: toolHandlers,
      context: serverContext,
      logger,
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
  };

  beforeEach(async () => {
    store = createMemoryStore();
    await store.productions.save(createDemoMovie());
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("registration from the registry", () => {
    it("advertises only tools that have a handler, with schemas from the contracts", async () => {
      await connect(handlers());
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(["get_production"]);
      expect(tools[0]?.description).toContain("timezone");
      expect(tools[0]?.inputSchema).toMatchObject({
        type: "object",
        properties: { productionId: { type: "string" } },
        required: ["productionId"],
        additionalProperties: false,
      });
      expect(tools[0]?.outputSchema).toMatchObject({
        properties: { version: { type: "integer" } },
      });
    });

    it("can advertise every tool in the registry once every handler exists", async () => {
      const all = Object.fromEntries(
        MCP_TOOL_NAMES.map((name) => [name, async () => succeed({} as never)]),
      ) as ToolHandlers;
      await connect(all);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    });
  });

  describe("a successful call", () => {
    it("returns structured output plus a JSON text rendering", async () => {
      await connect(handlers());
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: DEMO },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        id: DEMO,
        name: "Demo Movie",
        timezone: "Asia/Manila",
        version: 1,
      });
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(
        result.structuredContent,
      );
    });

    it("logs the call with a correlation ID and duration, and nothing sensitive", async () => {
      await connect(handlers());
      await client.callTool({ name: "get_production", arguments: { productionId: DEMO } });

      const [line] = logger.lines;
      expect(line).toMatchObject({
        level: "info",
        event: "tool_call",
        fields: { tool: "get_production", correlationId: "corr-1", outcome: "ok" },
      });
      expect(typeof line?.fields["durationMs"]).toBe("number");
      expect(JSON.stringify(line)).not.toContain("Demo Movie");
    });

    it("hands the handler the acting identity and the correlation ID", async () => {
      let seen: unknown;
      await connect(
        handlers({
          get_production: async (_input, call) => {
            seen = call;
            return succeed({ id: DEMO, name: "x", timezone: "UTC", version: 1 });
          },
        }),
      );
      await client.callTool({ name: "get_production", arguments: { productionId: DEMO } });
      expect(seen).toEqual({ correlationId: "corr-1", actor: { type: "AGENT", id: "test-agent" } });
    });
  });

  describe("input validation before any handler runs", () => {
    it("rejects an unknown field rather than ignoring it", async () => {
      let handlerRan = false;
      await connect(
        handlers({
          get_production: async () => {
            handlerRan = true;
            return succeed({ id: DEMO, name: "x", timezone: "UTC", version: 1 });
          },
        }),
      );
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: DEMO, includeArchived: true },
      });

      expect(result.isError).toBe(true);
      expect(readToolError(result)).toMatchObject({
        code: "INVALID_INPUT",
        correlationId: "corr-1",
      });
      expect(handlerRan).toBe(false);
    });

    it("rejects a missing required field and names it", async () => {
      await connect(handlers());
      const result = await client.callTool({ name: "get_production", arguments: {} });
      expect(readToolError(result)).toMatchObject({
        code: "INVALID_INPUT",
        actual: "productionId",
      });
    });
  });

  describe("server-side authorisation", () => {
    it("refuses a production outside the allow-list before the handler runs", async () => {
      let handlerRan = false;
      await connect(
        handlers({
          get_production: async () => {
            handlerRan = true;
            return succeed({ id: "PROD-OTHER", name: "x", timezone: "UTC", version: 1 });
          },
        }),
      );
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: "PROD-OTHER" },
      });

      expect(result.isError).toBe(true);
      expect(readToolError(result)).toMatchObject({
        code: "TOOL_UNAUTHORIZED",
        actual: "PROD-OTHER",
      });
      expect(handlerRan).toBe(false);
      expect(logger.lines[0]?.fields).toMatchObject({
        outcome: "unauthorized",
        code: "TOOL_UNAUTHORIZED",
      });
    });

    it("lets a wildcard context reach any production", async () => {
      await connect(handlers(), { ...context, allowedProductionIds: "*" });
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: "PROD-GHOST" },
      });
      expect(readToolError(result)).toMatchObject({ code: "ENTITY_NOT_FOUND" });
    });

    it("refuses a tool that is not registered, listing what is", async () => {
      await connect(handlers());
      const result = await client.callTool({
        name: "apply_approved_proposal",
        arguments: { productionId: DEMO },
      });
      expect(readToolError(result)).toMatchObject({
        code: "TOOL_UNAUTHORIZED",
        nextStep: "Call one of: get_production.",
      });
    });
  });

  describe("failures", () => {
    it("forwards a use-case failure as a structured tool error with its code and next step", async () => {
      // Wildcard context, so the request reaches the handler instead of the
      // authorisation guard; the guard has its own tests above.
      await connect(handlers(), { ...context, allowedProductionIds: "*" });
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: "PROD-GHOST" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(readToolError(result)).toEqual({
        code: "ENTITY_NOT_FOUND",
        message: "Production PROD-GHOST does not exist.",
        correlationId: "corr-1",
        nextStep: "Use a known production ID.",
      });
    });

    it("turns a handler that throws into INTERNAL_ERROR with the correlation ID, and logs the crash", async () => {
      await connect(
        handlers({
          get_production: async () => {
            throw new Error("database on fire");
          },
        }),
      );
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: DEMO },
      });

      expect(readToolError(result)).toMatchObject({
        code: "INTERNAL_ERROR",
        correlationId: "corr-1",
      });
      expect(JSON.stringify(result.content)).not.toContain("database on fire");
      expect(logger.lines.find((line) => line.event === "tool_crash")?.fields["error"]).toBe(
        "database on fire",
      );
    });

    it("refuses to forward output that violates the tool's contract", async () => {
      await connect(
        handlers({
          get_production: async () => succeed({ id: DEMO, name: "x" } as never),
        }),
      );
      const result = await client.callTool({
        name: "get_production",
        arguments: { productionId: DEMO },
      });

      expect(readToolError(result)).toMatchObject({ code: "INTERNAL_ERROR" });
      expect(
        logger.lines.find((line) => line.event === "tool_output_invalid")?.fields,
      ).toMatchObject({
        tool: "get_production",
        path: "timezone",
      });
    });
  });
});
