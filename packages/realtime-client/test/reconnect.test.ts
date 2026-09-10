import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  createGetRecoverySnapshot,
  createJobTracker,
  createNotificationHub,
  forwardJobEvents,
} from "@pca/application";
import { DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { createMemoryStore } from "@pca/memory-store";
import { fixedClock, manualScheduler, sequentialIds } from "@pca/test-support";
import { createRealtimeGateway, type RealtimeGateway } from "@pca/ws-gateway";

import { createRealtimeClient, type SocketLike } from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const NOW = "2026-09-10T12:00:00.000Z";

const until = async (condition: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe("reconnect through a real gateway", () => {
  const gateways: RealtimeGateway[] = [];
  afterEach(async () => {
    for (const gateway of gateways.splice(0)) await gateway.close();
  });

  it("survives the gateway going away and coming back on the same port", async () => {
    const store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    const clock = fixedClock(NOW);
    const jobRuns = createMemoryJobRunRepository();
    const tracker = createJobTracker({ repository: jobRuns, clock, ids: sequentialIds() });
    const hub = createNotificationHub();
    forwardJobEvents(tracker, hub);
    const getSnapshot = createGetRecoverySnapshot({ repositories: store, jobRuns, clock });

    const start = async (port: number) => {
      const gateway = createRealtimeGateway({ hub, clock, heartbeatIntervalMs: 0 });
      gateways.push(gateway);
      return gateway.listen(port);
    };
    const first = await start(0);

    const scheduler = manualScheduler();
    const recoveries: string[] = [];
    const client = createRealtimeClient({
      url: first.url,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      recover: async (productionId) => {
        recoveries.push(productionId);
        const result = await getSnapshot({ productionId });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
      schedule: (task, delayMs) => scheduler.schedule(task, delayMs),
    });

    await tracker.start({ productionId: DEMO, correlationId: "corr-1", type: "ANALYZE_CHANGE" });
    client.follow(DEMO);
    client.connect();
    await until(() => client.view(DEMO)?.recoveredAt !== null, "first recovery");
    expect(client.view(DEMO)?.jobs.map((run) => run.id)).toEqual(["JOB-1"]);

    clock.advance(1000);
    await tracker.advance("JOB-1", "resolving");
    await until(() => client.view(DEMO)?.jobs[0]?.stage === "resolving", "live event");

    // The gateway dies; the run moves on while nobody is listening.
    await (gateways.shift() as RealtimeGateway).close();
    await until(() => client.status() === "reconnecting", "reconnecting");
    clock.advance(1000);
    await tracker.advance("JOB-1", "analyzing");
    clock.advance(1000);
    await tracker.start({ productionId: DEMO, correlationId: "corr-2", type: "ANALYZE_CHANGE" });

    await start(first.port);
    expect(scheduler.pending()).toBe(1);
    scheduler.runNext();
    await until(
      () =>
        client.status() === "open" &&
        recoveries.length === 2 &&
        (client.view(DEMO)?.jobs.length ?? 0) === 2,
      "recovered after reconnect",
    );
    expect(client.view(DEMO)?.jobs.map((run) => `${run.id}:${run.stage}`)).toEqual([
      "JOB-2:received",
      "JOB-1:analyzing",
    ]);

    clock.advance(1000);
    await tracker.advance("JOB-2", "resolving");
    await until(
      () => client.view(DEMO)?.jobs[0]?.stage === "resolving",
      "live event after reconnect",
    );
    client.close();
  });
});
