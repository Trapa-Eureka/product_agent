import { MongoMemoryReplSet } from "mongodb-memory-server";

import { connectMongoStore, type MongoStore } from "../src";

/**
 * One in-memory replica set per test file, many databases.
 *
 * Starting mongod costs seconds; creating a database costs nothing. Each
 * factory call therefore gets its own database name on a shared server, which
 * keeps tests isolated without paying the start-up cost per test. The first
 * ever run also downloads the mongod binary (about 66 MB, once, cached under
 * the user's home), which is the only network access in the test suite.
 */

let replicaSet: Promise<MongoMemoryReplSet> | undefined;
const openStores: MongoStore[] = [];
let databaseCounter = 0;

export const replicaSetUri = async (): Promise<string> => {
  replicaSet ??= MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  return (await replicaSet).getUri();
};

/** A store on a fresh database. Pass `databaseName` to reopen an existing one. */
export const openStore = async (databaseName?: string): Promise<MongoStore> => {
  const name = databaseName ?? `pca_test_${process.pid}_${++databaseCounter}`;
  const store = await connectMongoStore({
    uri: await replicaSetUri(),
    databaseName: name,
    now: () => "2026-09-10T11:05:00.000Z",
  });
  openStores.push(store);
  return store;
};

export const databaseNameOf = (store: MongoStore): string => store.databaseName;

export const shutdown = async (): Promise<void> => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
  if (replicaSet !== undefined) {
    await (await replicaSet).stop();
    replicaSet = undefined;
  }
};
