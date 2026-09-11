import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";

import type { Approval } from "@pca/contracts";
import { createDemoMovie } from "@pca/fixtures";

import { databaseNameOf, openStore, replicaSetUri, shutdown } from "./replica-set";

afterAll(shutdown);

const approval: Approval = {
  id: "A-1",
  productionId: "PROD-DEMO",
  proposalId: "P-1",
  proposalDigest: "b".repeat(64),
  productionVersion: 1,
  approvedBy: "coordinator@example.test",
  decision: "APPROVE",
  createdAt: "2026-09-10T12:00:00.000Z",
};

/** TASK-926 (SEC-015 / AUD-020): workflow rows are parsed on read and validated on write. */
describe("mongo store schema validation", () => {
  const rawCollection = async (databaseName: string, name: string) => {
    const client = new MongoClient(await replicaSetUri());
    await client.connect();
    return { collection: client.db(databaseName).collection(name), close: () => client.close() };
  };

  it("refuses a malformed approval on read with STORE_CORRUPT, naming the row and path but no value", async () => {
    const store = await openStore();
    const raw = await rawCollection(databaseNameOf(store), "approvals");
    await raw.collection.insertOne({
      _id: "PROD-DEMO::A-9" as never,
      ...approval,
      id: "A-9",
      decision: "MAYBE-LATER-SECRET",
    });
    await raw.close();
    const failure = await store.approvals
      .findByProposalId("PROD-DEMO", "P-1")
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /^STORE_CORRUPT: approvals row PROD-DEMO::A-9 in MongoDB .* at "decision"/u,
    );
    expect(message).not.toContain("MAYBE-LATER-SECRET");
  });

  it("refuses to write a record the contract would refuse, and writes nothing", async () => {
    const store = await openStore();
    await expect(
      store.approvals.save({ ...approval, approvedBy: "x".repeat(201) }),
    ).rejects.toThrow(/^STORE_INVALID_WRITE: refusing to write approvals row A-1 .* "approvedBy"/u);
    expect(await store.approvals.findById("PROD-DEMO", "A-1")).toBeNull();
    await expect(
      store.auditEvents.append({
        id: "AE-1",
        productionId: "PROD-DEMO",
        actorType: "USER",
        action: "",
        createdAt: "2026-09-10T12:00:00.000Z",
      }),
    ).rejects.toThrow(/STORE_INVALID_WRITE: refusing to write auditEvents row AE-1/u);
    expect(await store.auditEvents.list("PROD-DEMO")).toEqual([]);
  });

  it("parses idempotency and job-run rows the same way", async () => {
    const store = await openStore();
    await store.productions.save(createDemoMovie());
    const database = databaseNameOf(store);
    const idempotency = await rawCollection(database, "idempotency");
    await idempotency.collection.insertOne({
      productionId: "PROD-DEMO",
      key: "idem-key-0001",
      proposalId: "P-1",
      proposalDigest: "not-a-digest",
      productionVersionAfter: 2,
      affectedEntityIds: [],
    });
    await idempotency.close();
    await expect(store.idempotency.find("PROD-DEMO", "idem-key-0001")).rejects.toThrow(
      /STORE_CORRUPT: idempotency row .* at "proposalDigest"/u,
    );

    const jobRuns = await rawCollection(database, "jobRuns");
    await jobRuns.collection.insertOne({
      _id: "JOB-9" as never,
      id: "JOB-9",
      stage: "nowhere",
      _rev: 1,
    });
    await jobRuns.close();
    await expect(store.jobRuns.findById("JOB-9")).rejects.toThrow(
      /STORE_CORRUPT: jobRuns row JOB-9/u,
    );
  });
});
