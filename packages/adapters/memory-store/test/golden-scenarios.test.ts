import { describeGoldenScenarios } from "@pca/test-support";

import { createMemoryStore } from "../src";

describeGoldenScenarios("memory store", () =>
  Promise.resolve(createMemoryStore({ now: () => "2026-09-10T11:05:00.000Z" })),
);
