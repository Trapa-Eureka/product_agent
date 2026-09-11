import { beforeEach, describe, expect, it } from "vitest";

import type { AgentJobEvent, JobRun, Proposal, RecoverySnapshot } from "@pca/contracts";
import { startJobRun } from "@pca/application";
import { manualScheduler } from "@pca/test-support";

import {
  applyJobEvent,
  applyProposalNotification,
  createRealtimeClient,
  type ClientStatus,
  type ProductionView,
  type RealtimeClient,
  type SocketLike,
} from "../src";

const NOW = "2026-09-10T12:00:00.000Z";
const LATER = "2026-09-10T12:00:05.000Z";
const DEMO = "PROD-DEMO";

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  closedWith: number | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.drop(code);
  }

  /** Server side: the connection is up and the server greets. */
  welcome(): void {
    this.readyState = 1;
    this.onopen?.({});
    this.receive({ type: "welcome", protocolVersion: 1, serverTime: NOW, canonicalSource: "rest" });
  }

  /** Server side: acknowledges every subscribe sent so far, as the gateway would. */
  ack(): void {
    for (const message of this.sentMessages()) {
      const parsed = message as { type: string; productionId?: string };
      if (
        parsed.type === "subscribe" &&
        parsed.productionId !== undefined &&
        !this.acked.has(parsed.productionId)
      ) {
        this.acked.add(parsed.productionId);
        this.receive({ type: "subscribed", productionId: parsed.productionId });
      }
    }
  }

  private readonly acked = new Set<string>();

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }

  sentMessages(): unknown[] {
    return this.sent.map((entry) => JSON.parse(entry) as unknown);
  }
}

const run = (id = "JOB-1"): JobRun =>
  startJobRun({ id, productionId: DEMO, correlationId: "corr-1", type: "ANALYZE_CHANGE", now: NOW })
    .run;

const proposal = (id = "P-1"): Proposal => ({
  id,
  productionId: DEMO,
  changeRequestId: "CR-1",
  baseProductionVersion: 1,
  operations: [{ type: "MARK_CALL_SHEET_STALE", callSheetId: "CS-2026-09-18" }],
  impacts: [],
  conflicts: [],
  warnings: [],
  validationStatus: "VALID",
  status: "AWAITING_APPROVAL",
  digest: "a".repeat(64),
  summary: "Move Scene 07",
  createdAt: NOW,
});

const event = (
  stage: AgentJobEvent["stage"],
  status: AgentJobEvent["status"],
  occurredAt = LATER,
  jobId = "JOB-1",
): AgentJobEvent => ({
  jobId,
  productionId: DEMO,
  correlationId: "corr-1",
  stage,
  status,
  occurredAt,
});

const snapshotOf = (
  jobs: JobRun[],
  openProposals: Proposal[] = [],
  asOf = NOW,
): RecoverySnapshot => ({
  productionId: DEMO,
  productionVersion: 1,
  asOf,
  jobs,
  openProposals,
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("applyJobEvent", () => {
  it("appends a new event and moves the run", () => {
    const merged = applyJobEvent(run(), event("resolving", "STARTED"));
    expect(merged).toMatchObject({ stage: "resolving", status: "STARTED", updatedAt: LATER });
    expect(merged?.history).toHaveLength(2);
  });

  it("ignores an event the run already holds, an older one, and another job's", () => {
    const base = run();
    expect(applyJobEvent(base, base.history[0] as AgentJobEvent)).toBeNull();
    expect(
      applyJobEvent(base, event("resolving", "STARTED", "2026-09-10T11:00:00.000Z")),
    ).toBeNull();
    expect(applyJobEvent(base, event("resolving", "STARTED", LATER, "JOB-2"))).toBeNull();
  });

  it("maps a FAILED event to the failed stage, keeping the message", () => {
    const merged = applyJobEvent(run(), { ...event("analyzing", "FAILED"), message: "boom" });
    expect(merged).toMatchObject({ stage: "failed", status: "FAILED", message: "boom" });
  });
});

describe("applyProposalNotification", () => {
  it("updates status, validation, and summary, and ignores a repeat", () => {
    const notification = {
      productionId: DEMO,
      proposalId: "P-1",
      changeRequestId: "CR-1",
      status: "APPROVED" as const,
      validationStatus: "VALID" as const,
      summary: "Move Scene 07",
      occurredAt: LATER,
    };
    const merged = applyProposalNotification(proposal(), notification);
    expect(merged?.status).toBe("APPROVED");
    expect(applyProposalNotification(merged as Proposal, notification)).toBeNull();
    expect(applyProposalNotification(proposal("P-2"), notification)).toBeNull();
  });
});

describe("realtime client", () => {
  let sockets: FakeSocket[];
  let scheduler: ReturnType<typeof manualScheduler>;
  let recoverCalls: string[];
  let snapshot: RecoverySnapshot;
  let recoverGate: (() => void) | null;
  let views: ProductionView[];
  let statuses: [ClientStatus, number][];
  let errors: string[];
  /** How many of the next recovery reads reject with "api down". */
  let failNextRecoveries: number;
  let client: RealtimeClient;

  const latestSocket = () => sockets[sockets.length - 1] as FakeSocket;

  beforeEach(() => {
    sockets = [];
    scheduler = manualScheduler();
    recoverCalls = [];
    snapshot = snapshotOf([run()], [proposal()]);
    recoverGate = null;
    views = [];
    statuses = [];
    errors = [];
    failNextRecoveries = 0;
    client = createRealtimeClient({
      url: "ws://test/ws",
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      recover: (productionId) => {
        recoverCalls.push(productionId);
        if (failNextRecoveries > 0) {
          failNextRecoveries -= 1;
          return Promise.reject(new Error("api down"));
        }
        if (recoverGate === null) return Promise.resolve(snapshot);
        return new Promise((resolve) => {
          const release = recoverGate as () => void;
          recoverGate = () => {
            release();
            resolve(snapshot);
          };
        });
      },
      schedule: (task, delayMs) => scheduler.schedule(task, delayMs),
      onChange: (view) => views.push(view),
      onStatus: (status, attempt) => statuses.push([status, attempt]),
      onRecoveryError: (productionId, error) =>
        errors.push(`${productionId}:${(error as Error).message}`),
    });
  });

  const proposalNotification = (
    status: Proposal["status"],
    proposalId = "P-1",
  ): Record<string, unknown> => ({
    type: "proposal",
    proposal: {
      productionId: DEMO,
      proposalId,
      changeRequestId: "CR-1",
      status,
      validationStatus: "VALID",
      summary: "Move Scene 07",
      occurredAt: LATER,
    },
  });

  /** Connects, follows DEMO, and completes the first recovery. */
  const connectAndRecover = async (): Promise<void> => {
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
  };

  it("after welcome, subscribes to every followed production and recovers each once the server acknowledges", async () => {
    client.follow(DEMO);
    client.connect();
    expect(client.status()).toBe("connecting");
    latestSocket().welcome();
    await flush();
    expect(latestSocket().sentMessages()).toEqual([{ type: "subscribe", productionId: DEMO }]);
    expect(recoverCalls).toEqual([]);
    expect(client.status()).toBe("open");
    latestSocket().ack();
    await flush();
    expect(recoverCalls).toEqual([DEMO]);
    expect(client.status()).toBe("open");
    expect(client.view(DEMO)).toMatchObject({
      productionVersion: 1,
      recoveredAt: NOW,
      recovering: false,
      jobs: [expect.objectContaining({ id: "JOB-1" })],
      openProposals: [expect.objectContaining({ id: "P-1" })],
    });
  });

  it("following while open subscribes, and recovers when acknowledged", async () => {
    client.connect();
    latestSocket().welcome();
    client.follow(DEMO);
    await flush();
    expect(latestSocket().sentMessages()).toEqual([{ type: "subscribe", productionId: DEMO }]);
    expect(recoverCalls).toEqual([]);
    latestSocket().ack();
    await flush();
    expect(recoverCalls).toEqual([DEMO]);
    client.unfollow(DEMO);
    expect(latestSocket().sentMessages().at(-1)).toEqual({
      type: "unsubscribe",
      productionId: DEMO,
    });
    expect(client.view(DEMO)).toBeNull();
  });

  it("applies live job events on top of the snapshot and ignores what the snapshot already holds", async () => {
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    const before = views.length;
    latestSocket().receive({ type: "job", event: (snapshot.jobs[0] as JobRun).history[0] });
    expect(views).toHaveLength(before);
    latestSocket().receive({ type: "job", event: event("resolving", "STARTED") });
    expect(client.view(DEMO)?.jobs[0]).toMatchObject({ stage: "resolving", updatedAt: LATER });
    expect(recoverCalls).toEqual([DEMO]);
  });

  it("recovers again when a notification names a job or proposal it does not know", async () => {
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    latestSocket().receive({ type: "job", event: event("received", "STARTED", LATER, "JOB-2") });
    await flush();
    expect(recoverCalls).toEqual([DEMO, DEMO]);
    latestSocket().receive({
      type: "proposal",
      proposal: {
        productionId: DEMO,
        proposalId: "P-9",
        changeRequestId: "CR-9",
        status: "AWAITING_APPROVAL",
        validationStatus: "VALID",
        summary: "New",
        occurredAt: LATER,
      },
    });
    await flush();
    expect(recoverCalls).toEqual([DEMO, DEMO, DEMO]);
  });

  it("updates a known proposal's status from a notification", async () => {
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    latestSocket().receive({
      type: "proposal",
      proposal: {
        productionId: DEMO,
        proposalId: "P-1",
        changeRequestId: "CR-1",
        status: "APPROVED",
        validationStatus: "VALID",
        summary: "Move Scene 07",
        occurredAt: LATER,
      },
    });
    expect(client.view(DEMO)?.openProposals[0]?.status).toBe("APPROVED");
    expect(recoverCalls).toEqual([DEMO]);
  });

  it("holds notifications that arrive during a recovery and applies them after the snapshot", async () => {
    recoverGate = () => undefined;
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    expect(client.view(DEMO)?.recovering).toBe(true);
    latestSocket().receive({ type: "job", event: event("resolving", "STARTED") });
    expect(client.view(DEMO)?.jobs).toEqual([]);
    recoverGate();
    await flush();
    expect(client.view(DEMO)?.jobs[0]).toMatchObject({ stage: "resolving", updatedAt: LATER });
    expect(recoverCalls).toEqual([DEMO]);
  });

  it("collapses recovery requests made while one is in flight into a single follow-up", async () => {
    recoverGate = () => undefined;
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    await client.recover(DEMO);
    await client.recover(DEMO);
    recoverGate();
    recoverGate = null;
    await flush();
    expect(recoverCalls).toEqual([DEMO, DEMO]);
  });

  it("reconnects with backoff after the socket drops, re-subscribes, and recovers again", async () => {
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();

    latestSocket().drop();
    expect(client.status()).toBe("reconnecting");
    expect(client.reconnectAttempts()).toBe(1);
    expect(scheduler.delays).toEqual([500]);
    expect(sockets).toHaveLength(1);

    scheduler.runNext();
    expect(sockets).toHaveLength(2);
    latestSocket().drop();
    expect(scheduler.delays).toEqual([500, 1000]);
    scheduler.runNext();
    latestSocket().drop();
    expect(scheduler.delays).toEqual([500, 1000, 2000]);
    scheduler.runNext();

    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    expect(client.status()).toBe("open");
    expect(client.reconnectAttempts()).toBe(0);
    expect(latestSocket().sentMessages()).toEqual([{ type: "subscribe", productionId: DEMO }]);
    expect(recoverCalls).toEqual([DEMO, DEMO]);
    expect(statuses.map(([status]) => status)).toEqual([
      "connecting",
      "open",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "open",
    ]);
  });

  it("drops held notifications when the socket closes mid-recovery; the next recovery is the truth", async () => {
    recoverGate = () => undefined;
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    latestSocket().receive({ type: "job", event: event("resolving", "STARTED") });
    latestSocket().drop();
    recoverGate();
    recoverGate = null;
    await flush();
    expect(client.view(DEMO)?.jobs[0]?.stage).toBe("received");
  });

  // TASK-910 (code review #11): closed proposals leave the open list; APPLIED refreshes the version.

  it("removes a proposal from openProposals when it is APPLIED and recovers to learn the new version", async () => {
    await connectAndRecover();
    expect(client.view(DEMO)).toMatchObject({ productionVersion: 1 });
    snapshot = { ...snapshotOf([run()], []), productionVersion: 2, asOf: LATER };
    latestSocket().receive(proposalNotification("APPLIED"));
    await flush();
    expect(client.view(DEMO)).toMatchObject({
      productionVersion: 2,
      openProposals: [],
      recoveredAt: LATER,
      recovering: false,
    });
    expect(recoverCalls).toEqual([DEMO, DEMO]);
    // The proposal left the list before the read, so nothing closed is ever shown as open.
    const beforeRead = views.find((view) => view.productionVersion === 1 && view.recovering);
    expect(beforeRead?.openProposals).toEqual([]);
  });

  it.each(["REJECTED", "FAILED"] as const)(
    "removes a %s proposal from openProposals without another read: the version did not move",
    async (status) => {
      await connectAndRecover();
      latestSocket().receive(proposalNotification(status));
      await flush();
      expect(client.view(DEMO)?.openProposals).toEqual([]);
      expect(recoverCalls).toEqual([DEMO]);
    },
  );

  it("keeps a proposal that is APPROVED: a coordinator still watches it until it is applied", async () => {
    await connectAndRecover();
    latestSocket().receive(proposalNotification("APPROVED"));
    expect(client.view(DEMO)?.openProposals.map((p) => p.status)).toEqual(["APPROVED"]);
    expect(recoverCalls).toEqual([DEMO]);
  });

  // TASK-910 (code review #12): a failed recovery read is retried; nothing is applied without a baseline.

  it("keeps holding after a failed recovery read and retries with backoff until the snapshot arrives", async () => {
    failNextRecoveries = 1;
    await connectAndRecover();
    expect(errors).toEqual([`${DEMO}:api down`]);
    expect(client.view(DEMO)).toMatchObject({ recovering: true, recoveredAt: null, jobs: [] });
    expect(scheduler.delays).toEqual([500]);

    // A notification during the outage is held, not applied to nothing and not a reason to read early.
    latestSocket().receive({ type: "job", event: event("resolving", "STARTED") });
    expect(client.view(DEMO)?.jobs).toEqual([]);
    expect(recoverCalls).toEqual([DEMO]);

    expect(scheduler.runNext()).toBe(true);
    await flush();
    expect(recoverCalls).toEqual([DEMO, DEMO]);
    expect(client.view(DEMO)).toMatchObject({ recovering: false, recoveredAt: NOW });
    expect(client.view(DEMO)?.jobs[0]).toMatchObject({ stage: "resolving", updatedAt: LATER });
  });

  it("backs off across consecutive failed reads and starts over after a success", async () => {
    failNextRecoveries = 2;
    await connectAndRecover();
    scheduler.runNext();
    await flush();
    expect(errors).toHaveLength(2);
    expect(scheduler.delays).toEqual([500, 1000]);
    scheduler.runNext();
    await flush();
    expect(client.view(DEMO)?.recovering).toBe(false);

    failNextRecoveries = 1;
    await client.recover(DEMO);
    expect(scheduler.delays).toEqual([500, 1000, 500]);
    expect(scheduler.pending()).toBe(1);
  });

  it("a manual recover while a retry is pending reads now and cancels the retry", async () => {
    failNextRecoveries = 1;
    await connectAndRecover();
    expect(scheduler.pending()).toBe(1);
    await client.recover(DEMO);
    expect(scheduler.pending()).toBe(0);
    expect(recoverCalls).toEqual([DEMO, DEMO]);
    expect(client.view(DEMO)?.recovering).toBe(false);
  });

  it("a socket drop while a retry is pending cancels it; the reconnect recovers from scratch, once", async () => {
    failNextRecoveries = 1;
    await connectAndRecover();
    latestSocket().receive({ type: "job", event: event("resolving", "STARTED") });
    latestSocket().drop();
    expect(client.view(DEMO)?.recovering).toBe(false);
    // Only the reconnect timer remains; the recovery retry is gone.
    expect(scheduler.pending()).toBe(1);
    scheduler.runNext();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    expect(recoverCalls).toEqual([DEMO, DEMO]);
    expect(client.view(DEMO)).toMatchObject({ recovering: false, recoveredAt: NOW });
    // What was held during the outage was dropped with the socket: the fresh snapshot is the truth.
    expect(client.view(DEMO)?.jobs[0]?.stage).toBe("received");
  });

  it("close cancels a pending recovery retry", async () => {
    failNextRecoveries = 1;
    await connectAndRecover();
    expect(scheduler.pending()).toBe(1);
    client.close();
    expect(scheduler.pending()).toBe(0);
    expect(client.view(DEMO)?.recovering).toBe(false);
    expect(client.status()).toBe("closed");
  });

  it("close stops reconnecting and ignores messages from a superseded socket", async () => {
    client.follow(DEMO);
    client.connect();
    latestSocket().welcome();
    latestSocket().ack();
    await flush();
    const first = latestSocket();
    first.drop();
    scheduler.runNext();
    const second = latestSocket();
    first.receive({ type: "job", event: event("resolving", "STARTED") });
    expect(client.view(DEMO)?.jobs[0]?.stage).toBe("received");

    client.close();
    expect(second.closedWith).toBe(1000);
    expect(client.status()).toBe("closed");
    expect(scheduler.pending()).toBe(0);
    client.connect();
    expect(sockets).toHaveLength(3);
  });
});
