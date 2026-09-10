import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InfrastructureError, guardRepositories } from "@pca/application";
import { createDemoMovie } from "@pca/fixtures";

import { connectMongoStore, type MongoStore } from "../src";

/**
 * TESTING.md §8: a Mongo repository failure must surface as a named boundary,
 * not as a driver message an operator has to decode.
 */
describe("mongo store failure", () => {
  let replSet: MongoMemoryReplSet;
  let store: MongoStore;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    store = await connectMongoStore({ uri: replSet.getUri(), databaseName: "pca_failure" });
    await store.productions.save(createDemoMovie());
  }, 120_000);

  afterAll(async () => {
    await replSet.stop();
  });

  it("after the client is closed, a guarded read names mongo.productions.loadState", async () => {
    const guarded = guardRepositories("mongo", {
      productions: store.productions,
      changeRequests: store.changeRequests,
      proposals: store.proposals,
      approvals: store.approvals,
      auditEvents: store.auditEvents,
      idempotency: store.idempotency,
    });
    expect((await guarded.productions.loadState("PROD-DEMO"))?.production.id).toBe("PROD-DEMO");

    await store.close();

    const failure = await guarded.productions
      .loadState("PROD-DEMO")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).boundary).toBe("mongo.productions.loadState");
    expect((failure as InfrastructureError).message).toMatch(
      /^mongo\.productions\.loadState failed: /,
    );
  });
});
