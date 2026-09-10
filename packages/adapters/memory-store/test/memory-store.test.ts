import { describe, expect, it } from "vitest";

import { describeRepositoryContract } from "@pca/test-support";
import { createDemoMovie } from "@pca/fixtures";

import { createMemoryStore } from "../src";

describeRepositoryContract("memory store", () =>
  Promise.resolve({ repositories: createMemoryStore({ now: () => "2026-09-10T12:00:00.000Z" }) }),
);

describe("memory store specifics", () => {
  it("stamps the committed time from the injected clock", async () => {
    const store = createMemoryStore({ now: () => "2026-09-10T12:00:00.000Z" });
    await store.productions.save(createDemoMovie());
    await store.productions.commit({ productionId: "PROD-DEMO", expectedVersion: 1 });

    expect((await store.productions.loadState("PROD-DEMO"))?.production.updatedAt).toBe(
      "2026-09-10T12:00:00.000Z",
    );
  });

  it("starts empty, so one test cannot see another's data", async () => {
    expect(await createMemoryStore().productions.loadState("PROD-DEMO")).toBeNull();
  });
});
