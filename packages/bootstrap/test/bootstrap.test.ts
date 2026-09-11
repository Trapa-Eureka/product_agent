import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { LogFields, LogLevel } from "@pca/application";
import { createDemoMovie } from "@pca/fixtures";

import {
  createJobRuns,
  createModel,
  createQueue,
  createRepositories,
  resetDemoMovie,
  selectModel,
  selectQueue,
  selectStorage,
} from "../src";

/** Collects log lines instead of printing them, so a test can assert on shape. */
const recordingLogger = (): {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[];
  log: (level: LogLevel, event: string, fields?: LogFields) => void;
} => {
  const lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  return {
    lines,
    log: (level, event, fields = {}) => {
      lines.push({ level, event, fields });
    },
  };
};

describe("selectStorage", () => {
  it("defaults to the file store, the free zero-install path", () => {
    expect(selectStorage({}).kind).toBe("file");
  });

  it("honours PCA_STORAGE and its companion variables", () => {
    expect(selectStorage({ PCA_STORAGE: "memory" })).toEqual({ kind: "memory" });
    expect(selectStorage({ PCA_STORAGE: "file", PCA_DATA_FILE: "/tmp/x.json" })).toEqual({
      kind: "file",
      filePath: "/tmp/x.json",
      permissions: "tighten",
    });
    // TASK-921: the permission policy is read here and refused when it is neither value.
    expect(
      selectStorage({ PCA_STORAGE: "file", PCA_DATA_FILE_PERMISSIONS: "refuse" }).kind === "file" &&
        (
          selectStorage({ PCA_STORAGE: "file", PCA_DATA_FILE_PERMISSIONS: "refuse" }) as {
            permissions: string;
          }
        ).permissions,
    ).toBe("refuse");
    expect(() =>
      selectStorage({ PCA_STORAGE: "file", PCA_DATA_FILE_PERMISSIONS: "loose" }),
    ).toThrow(/PCA_DATA_FILE_PERMISSIONS/u);
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
    const { repositories, close } = await createRepositories({
      kind: "file",
      filePath,
      permissions: "tighten",
    });
    await repositories.productions.save(createDemoMovie());
    expect((await repositories.productions.loadState("PROD-DEMO"))?.production.name).toBe(
      "Demo Movie",
    );
    await close();
  });

  it("threads a logger through to every repository call (TASK-804)", async () => {
    const logger = recordingLogger();
    const { repositories, close } = await createRepositories({ kind: "memory" }, { logger });

    await repositories.productions.loadState("PROD-DEMO");

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", event: "db_call" });
    expect(logger.lines[0]?.fields["boundary"]).toBe("memory.productions.loadState");
    await close();
  });
});

describe("resetDemoMovie (TASK-801)", () => {
  it("restores the Demo Movie fixture into the file store the environment names", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "pca-bootstrap-")), "data.json");
    const env = { PCA_STORAGE: "file", PCA_DATA_FILE: filePath };

    const result = await resetDemoMovie(env);
    expect(result).toEqual({ filePath, productionId: "PROD-DEMO" });

    const { repositories, close } = await createRepositories({
      kind: "file",
      filePath,
      permissions: "tighten",
    });
    expect((await repositories.productions.loadState("PROD-DEMO"))?.scenes).toHaveLength(4);
    await close();
  });

  it("clears a previous run's stale audit trail rather than layering a new one on top", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "pca-bootstrap-")), "data.json");
    const env = { PCA_STORAGE: "file", PCA_DATA_FILE: filePath };

    const { repositories, close } = await createRepositories({
      kind: "file",
      filePath,
      permissions: "tighten",
    });
    await repositories.productions.save(createDemoMovie());
    await repositories.auditEvents.append({
      id: "AE-STALE",
      productionId: "PROD-DEMO",
      actorType: "SYSTEM",
      action: "CHANGE_REQUEST_SUBMITTED",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await close();

    await resetDemoMovie(env);

    const reopened = await createRepositories({ kind: "file", filePath, permissions: "tighten" });
    expect(await reopened.repositories.auditEvents.list("PROD-DEMO")).toEqual([]);
    await reopened.close();
  });

  it("refuses for any storage kind other than the file store", async () => {
    await expect(resetDemoMovie({ PCA_STORAGE: "memory" })).rejects.toThrow(/file store/u);
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

  it("threads a logger through to every model call (TASK-804)", async () => {
    const logger = recordingLogger();
    const model = createModel("rules", { logger });

    await model.interpretChange({
      productionId: "PROD-DEMO",
      text: "Sarah cannot shoot Friday.",
      context: {
        castMembers: [{ id: "CAST-SARAH", name: "Sarah" }],
        locations: [],
        scenes: [],
        shootDays: [],
        today: "2026-09-10",
      },
    });

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", event: "model_call" });
    expect(logger.lines[0]?.fields["operation"]).toBe("interpretChange");
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

  it("keeps job runs beside the in-process queue", async () => {
    const runs = createJobRuns("memory");
    expect(await runs.findById("JOB-1")).toBeNull();
    expect(() => createJobRuns("sqs")).toThrow(/deferred/u);
  });

  it("refuses an unknown queue kind, and names the deferred one honestly", () => {
    expect(() => selectQueue({ PCA_QUEUE: "rabbit" })).toThrow(/memory, sqs/u);
    expect(() => createQueue("sqs")).toThrow(/deferred/u);
  });
});
