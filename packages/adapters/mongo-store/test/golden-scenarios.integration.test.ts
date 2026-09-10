import { afterAll } from "vitest";

import { describeGoldenScenarios } from "@pca/test-support";

import { openStore, shutdown } from "./replica-set";

afterAll(shutdown);

/** The same acceptance suite, against MongoDB with real transactions. */
describeGoldenScenarios("mongo store", () => openStore());
