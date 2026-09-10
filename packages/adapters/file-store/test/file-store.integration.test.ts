import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDemoMovie } from "@pca/fixtures";
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
});
