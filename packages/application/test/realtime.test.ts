import { beforeEach, describe, expect, it } from "vitest";

import type { RealtimeNotification } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryJobRunRepository } from "@pca/memory-queue";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, onDay, sequentialIds } from "@pca/test-support";

import {
  createCreateProposal,
  createDecideProposal,
  createJobTracker,
  createNotificationHub,
  createSubmitChangeRequest,
  forwardJobEvents,
  withProposalNotifications,
  type NotificationHub,
  type RepositorySet,
} from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const NOW = "2026-09-10T12:00:00.000Z";

describe("notification hub", () => {
  it("fans out to every subscriber until they unsubscribe", () => {
    const hub = createNotificationHub();
    const seen: string[] = [];
    const stop = hub.subscribe((notification) => seen.push(`a:${notification.type}`));
    hub.subscribe((notification) => seen.push(`b:${notification.type}`));
    const event = {
      jobId: "JOB-1",
      productionId: DEMO,
      correlationId: "corr-1",
      stage: "received" as const,
      status: "STARTED" as const,
      occurredAt: NOW,
    };
    hub.publish({ type: "job", event });
    stop();
    hub.publish({ type: "job", event });
    expect(seen).toEqual(["a:job", "b:job", "b:job"]);
  });

  it("forwards tracker events as job notifications", async () => {
    const hub = createNotificationHub();
    const tracker = createJobTracker({
      repository: createMemoryJobRunRepository(),
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });
    const seen: RealtimeNotification[] = [];
    hub.subscribe((notification) => seen.push(notification));
    const stop = forwardJobEvents(tracker, hub);
    await tracker.start({ productionId: DEMO, correlationId: "corr-1", type: "ANALYZE_CHANGE" });
    stop();
    await tracker.advance("JOB-1", "resolving");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "job",
      event: { stage: "received", status: "STARTED" },
    });
  });
});

describe("withProposalNotifications", () => {
  let store: MemoryStore;
  let hub: NotificationHub;
  let repositories: RepositorySet;
  let seen: RealtimeNotification[];

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    hub = createNotificationHub();
    seen = [];
    hub.subscribe((notification) => seen.push(notification));
    repositories = withProposalNotifications(store, hub, fixedClock(NOW));
  });

  it("notifies on creation and on decision, after each save has landed", async () => {
    const clock = fixedClock(NOW);
    const ids = sequentialIds();
    const submit = createSubmitChangeRequest({ repositories, clock, ids });
    const create = createCreateProposal({ repositories, clock, ids });
    const decide = createDecideProposal({ repositories, clock, ids });
    const landed: string[] = [];
    hub.subscribe((notification) => {
      if (notification.type !== "proposal") return;
      void store.proposals
        .findById(DEMO, notification.proposal.proposalId)
        .then((proposal) => landed.push(proposal?.status ?? "missing"));
    });

    const submitted = await submit({
      productionId: DEMO,
      rawText: "Sarah cannot shoot Friday.",
      change: {
        type: "CAST_UNAVAILABLE",
        castId: DEMO_MOVIE_IDS.cast.sarah,
        unavailable: onDay(DEMO_MOVIE_DATES.friday),
      },
      createdBy: "c",
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    const created = await create({
      productionId: DEMO,
      changeRequestId: submitted.value.id,
      baseProductionVersion: 1,
      operations: [
        {
          type: "RECORD_CAST_UNAVAILABILITY",
          castId: DEMO_MOVIE_IDS.cast.mike,
          unavailable: onDay(DEMO_MOVIE_DATES.friday),
        },
      ],
      summary: "Record Mike unavailable",
      proposedBy: "agent",
    });
    if (!created.ok) throw new Error(created.error.message);
    const decided = await decide({
      productionId: DEMO,
      proposalId: created.value.id,
      decision: "REJECT",
      decidedBy: "jinho@example.test",
    });
    if (!decided.ok) throw new Error(decided.error.message);

    expect(
      seen.map((notification) => notification.type === "proposal" && notification.proposal.status),
    ).toEqual(["AWAITING_APPROVAL", "REJECTED"]);
    expect(seen[0]).toEqual({
      type: "proposal",
      proposal: {
        productionId: DEMO,
        proposalId: created.value.id,
        changeRequestId: submitted.value.id,
        status: "AWAITING_APPROVAL",
        validationStatus: "VALID",
        summary: "Record Mike unavailable",
        occurredAt: NOW,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(landed).toEqual(["AWAITING_APPROVAL", "REJECTED"]);
  });

  it("leaves every other repository untouched and does not notify when the save throws", async () => {
    expect(repositories.productions).toBe(store.productions);
    expect(repositories.auditEvents).toBe(store.auditEvents);
    const broken = withProposalNotifications(
      {
        ...store,
        proposals: { ...store.proposals, save: () => Promise.reject(new Error("disk full")) },
      },
      hub,
      fixedClock(NOW),
    );
    await expect(
      broken.proposals.save({
        id: "P-9",
        productionId: DEMO,
        changeRequestId: "CR-1",
        baseProductionVersion: 1,
        operations: [
          { type: "MARK_CALL_SHEET_STALE", callSheetId: DEMO_MOVIE_IDS.callSheets.friday },
        ],
        impacts: [],
        conflicts: [],
        warnings: [],
        validationStatus: "VALID",
        status: "AWAITING_APPROVAL",
        digest: "a".repeat(64),
        summary: "x",
        createdAt: NOW,
      }),
    ).rejects.toThrow("disk full");
    expect(seen).toEqual([]);
  });
});
