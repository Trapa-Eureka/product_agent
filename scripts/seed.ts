#!/usr/bin/env -S node --import tsx
/**
 * TASK-801: one command restores the Demo Movie fixture into the file
 * store — before a demo take, after `verify` has been poking at it with
 * PCA_DATA_FILE unset, or any time the free local deployment's data file
 * needs a clean start. `PCA_DATA_FILE` (default `~/.production-change-agent/
 * data.json`, ARCHITECTURE.md §9) says which file; `resetDemoMovie`
 * (`@pca/bootstrap`) does the actual work, and refuses if `PCA_STORAGE` is
 * set to anything but the file store.
 *
 * This is the same function TASK-806's future `seed` CLI subcommand will
 * call, so that subcommand can exist later without this behavior moving.
 */
import { resetDemoMovie } from "@pca/bootstrap";

const main = async (): Promise<void> => {
  const result = await resetDemoMovie(process.env);
  process.stdout.write(
    `Demo Movie restored: production ${result.productionId} at ${result.filePath}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
