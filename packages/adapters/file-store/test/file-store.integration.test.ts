import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("TASK-906: refuses a record the schema rejects and leaves the previous database intact", async () => {
    const filePath = await temporaryFile();
    const store = createFileStore({ filePath });
    await store.productions.save(createDemoMovie());

    // A 129-character correlation ID: one over the contract. Before this the
    // record was written, and every later read failed with STORE_CORRUPT.
    await expect(
      store.changeRequests.save({
        id: "CR-BAD",
        productionId: "PROD-DEMO",
        type: "CAST_UNAVAILABLE",
        rawText: "Sarah cannot shoot Friday.",
        payload: {
          type: "CAST_UNAVAILABLE",
          castId: DEMO_MOVIE_IDS.cast.sarah,
          unavailable: { start: "2026-09-18", end: "2026-09-18" },
        },
        correlationId: "c".repeat(129),
        createdBy: "coordinator@example.test",
        createdAt: "2026-09-10T11:03:00.000Z",
      }),
    ).rejects.toThrow(/STORE_INVALID_WRITE.*correlationId/su);

    expect((await store.productions.loadState("PROD-DEMO"))?.scenes).toHaveLength(4);
    expect(await store.changeRequests.findById("PROD-DEMO", "CR-BAD")).toBeNull();
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

  describe("writer lock (TASK-903: code review #3 / AUD-006)", () => {
    const DEMO = DEMO_MOVIE_IDS.production;
    const taskFor = (id: string) => ({
      id,
      productionId: DEMO,
      title: id,
      relatedEntityType: "SCENE" as const,
      relatedEntityId: DEMO_MOVIE_IDS.scenes.s18,
      status: "OPEN" as const,
    });

    it("two instances on one file cannot both commit version 2", async () => {
      const filePath = await temporaryFile();
      const first = createFileStore({ filePath });
      const second = createFileStore({ filePath });
      await first.productions.save(createDemoMovie());

      // Each instance's own queue is empty, so both reach the file at once.
      // Before the lock, both read version 1 and both renamed a version 2
      // into place; the later rename silently dropped the earlier task.
      const [a, b] = await Promise.all([
        first.productions.commit({
          productionId: DEMO,
          expectedVersion: 1,
          tasks: [taskFor("T-A")],
        }),
        second.productions.commit({
          productionId: DEMO,
          expectedVersion: 1,
          tasks: [taskFor("T-B")],
        }),
      ]);

      expect([a.status, b.status].sort()).toEqual(["COMMITTED", "VERSION_MISMATCH"]);
      const state = await first.productions.loadState(DEMO);
      expect(state?.production.version).toBe(2);
      const written = state?.tasks.filter((task) => task.id === "T-A" || task.id === "T-B");
      expect(written).toHaveLength(1);
      expect(await readdir(join(filePath, ".."))).toEqual(["data.json"]);
    });

    it("two processes on one file cannot both commit version 2", async () => {
      const filePath = await temporaryFile();
      await createFileStore({ filePath }).productions.save(createDemoMovie());
      const worker = fileURLToPath(new URL("./helpers/commit-worker.ts", import.meta.url));
      const run = (taskId: string) =>
        new Promise<{ status: string }>((resolve, reject) => {
          execFile(
            process.execPath,
            ["--import", "tsx", worker, filePath, taskId],
            { cwd: fileURLToPath(new URL("..", import.meta.url)) },
            (error, stdout, stderr) => {
              if (error) reject(new Error(`${error.message}\n${stderr}`));
              else resolve(JSON.parse(stdout.trim()) as { status: string });
            },
          );
        });

      const [a, b] = await Promise.all([run("T-P1"), run("T-P2")]);

      expect([a.status, b.status].sort()).toEqual(["COMMITTED", "VERSION_MISMATCH"]);
      const state = await createFileStore({ filePath }).productions.loadState(DEMO);
      expect(state?.production.version).toBe(2);
      expect(state?.tasks.filter((t) => t.id.startsWith("T-P"))).toHaveLength(1);
    }, 30_000);

    it("reclaims a lock left behind by a process that no longer exists", async () => {
      const filePath = await temporaryFile();
      const store = createFileStore({ filePath, lockTimeoutMs: 500 });
      // A pid this high is not a live process on any supported platform.
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(
        store.lockPath,
        JSON.stringify({ pid: 2_147_483_000, acquiredAt: "2026-09-10T00:00:00.000Z" }),
      );

      await store.productions.save(createDemoMovie());

      expect((await store.productions.loadState(DEMO))?.scenes).toHaveLength(4);
      expect(await readdir(join(filePath, ".."))).toEqual(["data.json"]);
    });

    it("waits for a live writer, then fails with STORE_LOCKED rather than overwriting", async () => {
      const filePath = await temporaryFile();
      const store = createFileStore({ filePath, lockTimeoutMs: 200 });
      await mkdir(join(filePath, ".."), { recursive: true });
      // Held by "us": this process is alive, so the lock is never reclaimed.
      await writeFile(
        store.lockPath,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      );

      const started = Date.now();
      await expect(store.productions.save(createDemoMovie())).rejects.toThrow(/STORE_LOCKED/u);
      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
      expect(await store.productions.loadState(DEMO)).toBeNull();
    });
  });
});
