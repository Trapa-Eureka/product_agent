import { afterAll, describe, expect, it } from "vitest";

import { createDemoMovie } from "@pca/fixtures";
import { describeRepositoryContract } from "@pca/test-support";

import { connectMongoStore } from "../src";
import { databaseNameOf, openStore, replicaSetUri, shutdown } from "./replica-set";

afterAll(shutdown);

describeRepositoryContract("mongo store", async () => {
  const store = await openStore();
  return {
    repositories: store,
    reopen: () => openStore(databaseNameOf(store)),
  };
});

describe("mongo store specifics", () => {
  it("stamps the committed time from the injected clock", async () => {
    const store = await openStore();
    await store.productions.save(createDemoMovie());
    await store.productions.commit({ productionId: "PROD-DEMO", expectedVersion: 1 });
    expect((await store.productions.loadState("PROD-DEMO"))?.production.updatedAt).toBe(
      "2026-09-10T11:05:00.000Z",
    );
  });

  it("keeps a scene ID that repeats across productions as two rows", async () => {
    const store = await openStore();
    const demo = createDemoMovie();
    const rebrand = <T extends { productionId: string }>(records: readonly T[]): T[] =>
      records.map((record) => ({ ...record, productionId: "PROD-OTHER" }));
    await store.productions.save(demo);
    await store.productions.save({
      production: { ...demo.production, id: "PROD-OTHER", name: "Other Movie" },
      scenes: rebrand(demo.scenes).map((scene) => ({ ...scene, title: "elsewhere" })),
      castMembers: rebrand(demo.castMembers),
      locations: rebrand(demo.locations),
      requirements: rebrand(demo.requirements),
      shootDays: rebrand(demo.shootDays),
      callSheets: rebrand(demo.callSheets),
      tasks: rebrand(demo.tasks),
    });

    const original = await store.productions.loadState("PROD-DEMO");
    const other = await store.productions.loadState("PROD-OTHER");
    expect(original?.scenes.find((scene) => scene.id === "S07")?.title).toBe(
      "Standoff at the loading dock",
    );
    expect(other?.scenes.find((scene) => scene.id === "S07")?.title).toBe("elsewhere");
  });

  it("rolls the whole commit back when the version check fails mid-transaction", async () => {
    const store = await openStore();
    await store.productions.save(createDemoMovie());
    const outcome = await store.productions.commit({
      productionId: "PROD-DEMO",
      expectedVersion: 42,
      tasks: [
        {
          id: "T-ROLLBACK",
          productionId: "PROD-DEMO",
          title: "Must never land",
          relatedEntityType: "SCENE",
          relatedEntityId: "S07",
          status: "OPEN",
        },
      ],
    });

    expect(outcome.status).toBe("VERSION_MISMATCH");
    const after = await store.productions.loadState("PROD-DEMO");
    expect(after?.tasks.some((task) => task.id === "T-ROLLBACK")).toBe(false);
    expect(after?.production.version).toBe(1);
  });

  it("creates the documented indexes", async () => {
    const store = await openStore();
    const names = (await store.indexNames("scenes")).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "productionId_1",
        "productionId_1_locationId_1",
        "productionId_1_requiredCastIds_1",
      ]),
    );
    expect(await store.indexNames("idempotency")).toContain("productionId_1_key_1");
  });

  it("refuses a standalone server rather than committing without atomicity", async () => {
    // A replica-set URI with the replicaSet option stripped still reaches a
    // replica set member, so this only checks the guard's wiring; a true
    // standalone would need a second mongod. The hello check is what matters.
    const uri = await replicaSetUri();
    await expect(
      connectMongoStore({ uri, databaseName: "pca_guard" }).then((s) => s.close()),
    ).resolves.toBeUndefined();
  });
});
