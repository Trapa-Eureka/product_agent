import { createServer, type Server as HttpServer } from "node:http";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentJobEvent, RealtimeServerMessage } from "@pca/contracts";
import { realtimeServerMessageSchema } from "@pca/contracts";
import {
  createJobTracker,
  createNotificationHub,
  forwardJobEvents,
  type NotificationHub,
} from "@pca/application";
import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { fixedClock, sequentialIds } from "@pca/test-support";

import { createRealtimeGateway, rawDataToText, type RealtimeGateway } from "../src";

const NOW = "2026-09-10T12:00:00.000Z";

const jobEvent = (
  productionId = "PROD-DEMO",
  stage: AgentJobEvent["stage"] = "analyzing",
): AgentJobEvent => ({
  jobId: "JOB-1",
  productionId,
  correlationId: "corr-1",
  stage,
  status: "STARTED",
  occurredAt: NOW,
});

/** A client that queues every server message so a test can await them in order. */
const connect = (url: string) =>
  new Promise<{
    socket: WebSocket;
    next: () => Promise<RealtimeServerMessage>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue: RealtimeServerMessage[] = [];
    const waiters: ((message: RealtimeServerMessage) => void)[] = [];
    socket.on("message", (raw) => {
      const message = realtimeServerMessageSchema.parse(JSON.parse(rawDataToText(raw)));
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(message);
      else waiter(message);
    });
    socket.once("error", reject);
    socket.once("open", () =>
      resolve({
        socket,
        next: () =>
          new Promise((resolveNext) => {
            const queued = queue.shift();
            if (queued === undefined) waiters.push(resolveNext);
            else resolveNext(queued);
          }),
        close: () =>
          new Promise((resolveClose) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }
            socket.once("close", () => resolveClose());
            socket.close();
          }),
      }),
    );
  });

const sendJson = (socket: WebSocket, message: unknown): void => {
  socket.send(typeof message === "string" ? message : JSON.stringify(message));
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("realtime gateway", () => {
  let hub: NotificationHub;
  let gateway: RealtimeGateway;
  let url: string;
  const opened: { close: () => Promise<void> }[] = [];

  const client = async () => {
    const connection = await connect(url);
    opened.push(connection);
    return connection;
  };

  const subscribed = async (productionId = "PROD-DEMO") => {
    const connection = await client();
    expect((await connection.next()).type).toBe("welcome");
    sendJson(connection.socket, { type: "subscribe", productionId });
    expect(await connection.next()).toEqual({ type: "subscribed", productionId });
    return connection;
  };

  beforeEach(async () => {
    hub = createNotificationHub();
    gateway = createRealtimeGateway({
      hub,
      clock: fixedClock(NOW),
      heartbeatIntervalMs: 0,
      authorize: (productionId) => productionId !== "PROD-SECRET",
      maxSubscriptionsPerClient: 2,
    });
    ({ url } = await gateway.listen(0));
  });

  afterEach(async () => {
    for (const connection of opened.splice(0)) await connection.close().catch(() => undefined);
    await gateway.close();
  });

  it("greets every connection with the protocol version and the canonical source", async () => {
    const connection = await client();
    expect(await connection.next()).toEqual({
      type: "welcome",
      protocolVersion: 1,
      serverTime: NOW,
      canonicalSource: "rest",
    });
    expect(gateway.clientCount()).toBe(1);
  });

  it("delivers job events only to subscribers of that production", async () => {
    const demo = await subscribed("PROD-DEMO");
    const other = await subscribed("PROD-OTHER");
    const idle = await client();
    await idle.next();

    hub.publish({ type: "job", event: jobEvent("PROD-DEMO") });
    expect(await demo.next()).toEqual({ type: "job", event: jobEvent("PROD-DEMO") });

    hub.publish({ type: "job", event: jobEvent("PROD-OTHER", "simulating") });
    expect(await other.next()).toEqual({
      type: "job",
      event: jobEvent("PROD-OTHER", "simulating"),
    });

    let stray = false;
    void demo.next().then(() => {
      stray = true;
    });
    await settle();
    expect(stray).toBe(false);
    expect(gateway.subscriberCount("PROD-DEMO")).toBe(1);
  });

  it("delivers proposal status notifications", async () => {
    const demo = await subscribed();
    const proposal = {
      productionId: "PROD-DEMO",
      proposalId: "P-1",
      changeRequestId: "CR-1",
      status: "AWAITING_APPROVAL" as const,
      validationStatus: "VALID" as const,
      summary: "Move Scene 07",
      occurredAt: NOW,
    };
    hub.publish({ type: "proposal", proposal });
    expect(await demo.next()).toEqual({ type: "proposal", proposal });
  });

  it("carries a tracker's events end to end, in order", async () => {
    const tracker = createJobTracker({
      repository: createMemoryJobRunRepository(),
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });
    forwardJobEvents(tracker, hub);
    const demo = await subscribed();
    await tracker.start({
      productionId: "PROD-DEMO",
      correlationId: "corr-1",
      type: "ANALYZE_CHANGE",
    });
    await tracker.advance("JOB-1", "resolving");
    const received = [await demo.next(), await demo.next(), await demo.next()];
    expect(
      received.map((message) =>
        message.type === "job" ? `${message.event.stage}:${message.event.status}` : message.type,
      ),
    ).toEqual(["received:STARTED", "received:COMPLETED", "resolving:STARTED"]);
  });

  it("stops delivering after unsubscribe", async () => {
    const demo = await subscribed();
    sendJson(demo.socket, { type: "unsubscribe", productionId: "PROD-DEMO" });
    expect(await demo.next()).toEqual({ type: "unsubscribed", productionId: "PROD-DEMO" });
    hub.publish({ type: "job", event: jobEvent() });
    let stray = false;
    void demo.next().then(() => {
      stray = true;
    });
    await settle();
    expect(stray).toBe(false);
  });

  it("answers ping with pong", async () => {
    const connection = await client();
    await connection.next();
    sendJson(connection.socket, { type: "ping" });
    expect(await connection.next()).toEqual({ type: "pong", serverTime: NOW });
  });

  it("rejects malformed messages with an error and keeps the connection", async () => {
    const connection = await client();
    await connection.next();
    sendJson(connection.socket, "not json");
    expect(await connection.next()).toMatchObject({ type: "error", code: "MALFORMED_MESSAGE" });
    sendJson(connection.socket, { type: "subscribe" });
    expect(await connection.next()).toMatchObject({
      type: "error",
      code: "MALFORMED_MESSAGE",
      message: expect.stringContaining("productionId") as string,
    });
    sendJson(connection.socket, { type: "approve_everything" });
    expect(await connection.next()).toMatchObject({ type: "error", code: "MALFORMED_MESSAGE" });
    sendJson(connection.socket, { type: "ping" });
    expect((await connection.next()).type).toBe("pong");
    expect(gateway.clientCount()).toBe(1);
  });

  it("refuses a production the connection is not allowed to follow", async () => {
    const connection = await client();
    await connection.next();
    sendJson(connection.socket, { type: "subscribe", productionId: "PROD-SECRET" });
    expect(await connection.next()).toMatchObject({
      type: "error",
      code: "PRODUCTION_UNAUTHORIZED",
    });
    expect(gateway.subscriberCount("PROD-SECRET")).toBe(0);
    hub.publish({ type: "job", event: jobEvent("PROD-SECRET") });
    let stray = false;
    void connection.next().then(() => {
      stray = true;
    });
    await settle();
    expect(stray).toBe(false);
  });

  it("caps subscriptions per connection and treats a repeat subscribe as idempotent", async () => {
    const connection = await subscribed("PROD-A");
    sendJson(connection.socket, { type: "subscribe", productionId: "PROD-B" });
    expect(await connection.next()).toEqual({ type: "subscribed", productionId: "PROD-B" });
    sendJson(connection.socket, { type: "subscribe", productionId: "PROD-C" });
    expect(await connection.next()).toMatchObject({ type: "error", code: "SUBSCRIPTION_LIMIT" });
    sendJson(connection.socket, { type: "subscribe", productionId: "PROD-A" });
    expect(await connection.next()).toEqual({ type: "subscribed", productionId: "PROD-A" });
  });

  it("forgets a client that disconnects and keeps publishing to the rest", async () => {
    const leaving = await subscribed();
    const staying = await subscribed();
    await leaving.close();
    await settle();
    expect(gateway.clientCount()).toBe(1);
    expect(gateway.subscriberCount("PROD-DEMO")).toBe(1);
    hub.publish({ type: "job", event: jobEvent() });
    expect((await staying.next()).type).toBe("job");
  });

  it("closes clients with 1001 on shutdown", async () => {
    const connection = await client();
    await connection.next();
    const closed = new Promise<number>((resolve) =>
      connection.socket.once("close", (code) => resolve(code)),
    );
    await gateway.close();
    expect(await closed).toBe(1001);
    // Re-create so afterEach has something to close.
    gateway = createRealtimeGateway({ hub, clock: fixedClock(NOW), heartbeatIntervalMs: 0 });
    ({ url } = await gateway.listen(0));
  });

  it("keeps a live client through heartbeats", async () => {
    await gateway.close();
    gateway = createRealtimeGateway({ hub, clock: fixedClock(NOW), heartbeatIntervalMs: 10 });
    ({ url } = await gateway.listen(0));
    const connection = await client();
    await connection.next();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
    expect(gateway.clientCount()).toBe(1);
  });
});

describe("attaching to an existing HTTP server", () => {
  let httpServer: HttpServer;
  let gateway: RealtimeGateway;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer((_request, response) => {
      response.end("api");
    });
    gateway = createRealtimeGateway({
      hub: createNotificationHub(),
      clock: fixedClock(NOW),
      heartbeatIntervalMs: 0,
    });
    gateway.attach(httpServer, "/realtime");
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("serves upgrades on its path and refuses others", async () => {
    const connection = await connect(`ws://127.0.0.1:${port}/realtime`);
    expect((await connection.next()).type).toBe("welcome");
    await connection.close();

    const refused = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`);
    const outcome = await new Promise<string>((resolve) => {
      refused.once("error", () => resolve("error"));
      refused.once("open", () => resolve("open"));
    });
    expect(outcome).toBe("error");
  });
});
