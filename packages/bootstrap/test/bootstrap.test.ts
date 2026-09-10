import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDemoMovie } from "@pca/fixtures";

import {
  createModel,
  createQueue,
  createRepositories,
  selectModel,
  selectQueue,
  selectStorage,
} from "../src";

describe("selectStorage", () => {
  it("defaults to the file store, the free zero-install path", () => {
    expect(selectStorage({}).kind).toBe("file");
  });

  it("honours PCA_STORAGE and its companion variables", () => {
    expect(selectStorage({ PCA_STORAGE: "memory" })).toEqual({ kind: "memory" });
    expect(selectStorage({ PCA_STORAGE: "file", PCA_DATA_FILE: "/tmp/x.json" })).toEqual({
      kind: "file",
      filePath: "/tmp/x.json",
    });
    expect(
      selectStorage({
        PCA_STORAGE: "mongo",
        PCA_MONGO_URI: "mongodb://h/?replicaSet=r",
        PCA_MONGO_DB: "d",
      }),
    ).toEqual({ kind: "mongo", uri: "mongodb://h/?replicaSet=r", databaseName: "d" });
  });

  it("refuses an unknown storage kind with the valid options named", () => {
    expect(() => selectStorage({ PCA_STORAGE: "postgres" })).toThrow(/file, memory, mongo/u);
  });
});

describe("createRepositories", () => {
  it("builds a working memory store", async () => {
    const { repositories, close } = await createRepositories({ kind: "memory" });
    await repositories.productions.save(createDemoMovie());
    expect((await repositories.productions.loadState("PROD-DEMO"))?.scenes).toHaveLength(4);
    await close();
  });

  it("builds a working file store at the given path", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "pca-bootstrap-")), "data.json");
    const { repositories, close } = await createRepositories({ kind: "file", filePath });
    await repositories.productions.save(createDemoMovie());
    expect((await repositories.productions.loadState("PROD-DEMO"))?.production.name).toBe(
      "Demo Movie",
    );
    await close();
  });
});

describe("model selection", () => {
  it("defaults to the rule-based adapter, which needs no network", () => {
    expect(selectModel({})).toBe("rules");
    expect(typeof createModel("rules").interpretChange).toBe("function");
  });

  it("refuses an unknown model kind, and names the deferred ones honestly", () => {
    expect(() => selectModel({ PCA_MODEL: "gpt" })).toThrow(/rules, ollama, bedrock/u);
    expect(() => createModel("bedrock")).toThrow(/deferred/u);
    expect(() => createModel("ollama")).toThrow(/not wired yet/u);
  });
});

describe("queue selection", () => {
  it("defaults to the in-process queue, which needs no broker", async () => {
    expect(selectQueue({})).toBe("memory");
    const queue = createQueue("memory");
    queue.register("ANALYZE_CHANGE", () => Promise.resolve({ kind: "COMPLETED" }));
    const { record } = await queue.enqueue({
      type: "ANALYZE_CHANGE",
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      idempotencyKey: "idem-key-0001",
      payload: {},
    });
    await queue.drain();
    expect((await queue.getJob(record.job.id))?.state).toBe("COMPLETED");
  });

  it("refuses an unknown queue kind, and names the deferred one honestly", () => {
    expect(() => selectQueue({ PCA_QUEUE: "rabbit" })).toThrow(/memory, sqs/u);
    expect(() => createQueue("sqs")).toThrow(/deferred/u);
  });
});
