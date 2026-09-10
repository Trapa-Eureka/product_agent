import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { describeRepositoryContract } from "@pca/test-support";

import { createFileStore } from "../src";

/**
 * The file store is exercised against a real filesystem, so these are
 * integration tests. They still need no server, no account, and no network.
 */

const temporaryDirectories: string[] = [];

const temporaryFile = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "pca-file-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "data.json");
};

describeRepositoryContract("file store", async () => {
  const filePath = await temporaryFile();
  const now = () => "2026-09-10T12:00:00.000Z";
  return {
    repositories: createFileStore({ filePath, now }),
    reopen: () => Promise.resolve(createFileStore({ filePath, now })),
  };
});

describe("file store specifics", () => {
  afterEach(() => {
    temporaryDirectories.length = 0;
  });

  it("treats a missing file as an empty database rather than an error", async () => {
    const store = createFileStore({ filePath: await temporaryFile() });
    expect(await store.productions.loadState("PROD-DEMO")).toBeNull();
  });

  it("creates the parent directory on first write", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "pca-nested-")), "nested", "data.json");
    const store = createFileStore({ filePath });
    await store.productions.save(createDemoMovie());

    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ formatVersion: 1 });
  });

  it("leaves no temporary files behind after a write", async () => {
    const filePath = await temporaryFile();
    const store = createFileStore({ filePath });
    await store.productions.save(createDemoMovie());

    const entries = await readdir(join(filePath, ".."));
    expect(entries).toEqual(["data.json"]);
  });

  it("writes readable JSON, so a human can inspect the store", async () => {
    const filePath = await temporaryFile();
    await createFileStore({ filePath }).productions.save(createDemoMovie());

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("\n  ");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("refuses to read a file that is not JSON, and says which file", async () => {
    const filePath = await temporaryFile();
    await writeFile(filePath, "not json at all", "utf8");

    await expect(createFileStore({ filePath }).productions.loadState("PROD-DEMO")).rejects.toThrow(
      /STORE_CORRUPT.*data\.json.*not valid JSON/su,
    );
  });

  it("refuses to read a file whose contents do not match the format, and names the field", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        formatVersion: 1,
        productions: {},
        changeRequests: [],
        proposals: [],
        approvals: [],
        auditEvents: [{ id: "AE-1" }],
        idempotency: [],
      }),
      "utf8",
    );

    await expect(createFileStore({ filePath }).productions.loadState("PROD-DEMO")).rejects.toThrow(
      /STORE_CORRUPT.*auditEvents\.0/su,
    );
  });

  it("rejects a file written by a newer format version", async () => {
    const filePath = await temporaryFile();
    await writeFile(filePath, JSON.stringify({ formatVersion: 2, productions: {} }), "utf8");

    await expect(createFileStore({ filePath }).productions.loadState("PROD-DEMO")).rejects.toThrow(
      /STORE_CORRUPT/u,
    );
  });

  it("keeps the previous database intact when a write fails", async () => {
    const filePath = await temporaryFile();
    const store = createFileStore({ filePath });
    await store.productions.save(createDemoMovie());

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(
      store.auditEvents.append({
        id: "AE-1",
        productionId: "PROD-DEMO",
        actorType: "SYSTEM",
        action: "BROKEN",
        metadata: circular,
        createdAt: "2026-09-10T12:00:00.000Z",
      }),
    ).rejects.toThrow();

    expect((await store.productions.loadState("PROD-DEMO"))?.scenes).toHaveLength(4);
    expect(await readdir(join(filePath, ".."))).toEqual(["data.json"]);
  });

  describe("resetProduction (TASK-801)", () => {
    const DEMO = DEMO_MOVIE_IDS.production;
    const OTHER = "PROD-OTHER";

    it("restores the production's own state and clears its stale records", async () => {
      const filePath = await temporaryFile();
      const store = createFileStore({ filePath });
      await store.productions.save(createDemoMovie());
      await store.changeRequests.save({
        id: "CR-001",
        productionId: DEMO,
        type: "CAST_UNAVAILABLE",
        rawText: "Sarah cannot shoot Friday.",
        payload: {
          type: "CAST_UNAVAILABLE",
          castId: DEMO_MOVIE_IDS.cast.sarah,
          unavailable: { start: "2026-09-18", end: "2026-09-18" },
        },
        correlationId: "corr-001",
        createdBy: "coordinator@example.test",
        createdAt: "2026-09-10T11:03:00.000Z",
      });
      await store.proposals.save({
        id: "P-104",
        productionId: DEMO,
        changeRequestId: "CR-001",
        baseProductionVersion: 1,
        operations: [
          {
            type: "MOVE_SCENES",
            sceneIds: [DEMO_MOVIE_IDS.scenes.s07],
            fromShootDayId: DEMO_MOVIE_IDS.shootDays.friday,
            toShootDayId: DEMO_MOVIE_IDS.shootDays.monday,
          },
        ],
        impacts: [],
        conflicts: [],
        warnings: [],
        validationStatus: "VALID",
        status: "AWAITING_APPROVAL",
        digest: "a".repeat(64),
        summary: "Move Scene 07 to Monday.",
        createdAt: "2026-09-10T11:04:00.000Z",
      });
      await store.approvals.save({
        id: "A-77",
        productionId: DEMO,
        proposalId: "P-104",
        proposalDigest: "a".repeat(64),
        productionVersion: 1,
        approvedBy: "coordinator@example.test",
        decision: "APPROVE",
        createdAt: "2026-09-10T11:05:00.000Z",
      });
      await store.auditEvents.append({
        id: "AE-1",
        productionId: DEMO,
        actorType: "USER",
        action: "CHANGE_REQUEST_SUBMITTED",
        createdAt: "2026-09-10T11:03:00.000Z",
      });
      await store.idempotency.save(DEMO, {
        key: "apply:P-104:aaaaaaaaaaaaaaaa",
        proposalId: "P-104",
        proposalDigest: "a".repeat(64),
        productionVersionAfter: 2,
        affectedEntityIds: ["S07", "S12"],
      });

      await store.resetProduction(createDemoMovie());

      expect((await store.productions.loadState(DEMO))?.scenes).toHaveLength(4);
      expect(await store.changeRequests.findById(DEMO, "CR-001")).toBeNull();
      expect(await store.proposals.findById(DEMO, "P-104")).toBeNull();
      expect(await store.approvals.findById(DEMO, "A-77")).toBeNull();
      expect(await store.auditEvents.list(DEMO)).toEqual([]);
      expect(await store.idempotency.find(DEMO, "apply:P-104:aaaaaaaaaaaaaaaa")).toBeNull();
    });

    it("leaves another production's records untouched", async () => {
      const filePath = await temporaryFile();
      const store = createFileStore({ filePath });
      await store.productions.save(createDemoMovie());
      await store.auditEvents.append({
        id: "AE-OTHER",
        productionId: OTHER,
        actorType: "SYSTEM",
        action: "CHANGE_REQUEST_SUBMITTED",
        createdAt: "2026-09-10T11:03:00.000Z",
      });

      await store.resetProduction(createDemoMovie());

      expect(await store.auditEvents.list(OTHER)).toHaveLength(1);
    });
  });
});
