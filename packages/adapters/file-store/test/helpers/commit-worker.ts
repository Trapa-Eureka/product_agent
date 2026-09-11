import { createFileStore } from "../../src";

/**
 * A separate process that commits one mutation against the data file named
 * on the command line and prints the outcome as JSON. Two of these started
 * together are the cross-process race TASK-903 exists to serialise: without
 * the lock file both read version 1 and both report `COMMITTED`.
 */
const [filePath, taskId] = process.argv.slice(2);
if (filePath === undefined || taskId === undefined) {
  throw new Error("usage: commit-worker <data-file> <task-id>");
}

const store = createFileStore({ filePath });
const outcome = await store.productions.commit({
  productionId: "PROD-DEMO",
  expectedVersion: 1,
  tasks: [
    {
      id: taskId,
      productionId: "PROD-DEMO",
      title: `Written by process ${process.pid}`,
      relatedEntityType: "SCENE",
      relatedEntityId: "S18",
      status: "OPEN",
    },
  ],
});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
