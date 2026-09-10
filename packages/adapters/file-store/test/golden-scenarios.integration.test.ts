import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeGoldenScenarios } from "@pca/test-support";

import { createFileStore } from "../src";

/** The same acceptance suite, against a real file on disk. */
describeGoldenScenarios("file store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pca-golden-"));
  return createFileStore({
    filePath: join(directory, "data.json"),
    now: () => "2026-09-10T11:05:00.000Z",
  });
});
