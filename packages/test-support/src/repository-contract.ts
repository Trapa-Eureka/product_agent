import { beforeEach, describe, expect, it } from "vitest";

import type { Approval, AuditEvent, ChangeRequest, Proposal } from "@pca/contracts";
import type { RepositorySet } from "@pca/application";
import { ProductionIsolationError } from "@pca/application";
import type { ProductionState } from "@pca/domain";
import { DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";

/**
 * One contract suite, every adapter.
 *
 * An adapter that compiles against the ports has proved nothing. This suite is
 * what "the JSON store and MongoDB behave the same" actually means, so it runs
 * unchanged against each of them. When they disagree, the disagreement fails
 * here rather than in a use case that assumed one of them.
 */

export type RepositoryFactory = () => Promise<{
  repositories: RepositorySet;
  /** Optional second handle on the same storage, to prove writes really persist. */
  reopen?: () => Promise<RepositorySet>;
}>;

const OTHER_PRODUCTION = "PROD-OTHER";
const DEMO = DEMO_MOVIE_IDS.production;

const demoState = (): ProductionState => createDemoMovie();

const foreignState = (): ProductionState => {
  const state = createDemoMovie();
  const rebrand = <T extends { productionId: string }>(records: readonly T[]): T[] =>
    records.map((record) => ({ ...record, productionId: OTHER_PRODUCTION }));

  return {
    production: { ...state.production, id: OTHER_PRODUCTION, name: "Other Movie" },
    scenes: rebrand(state.scenes),
    castMembers: rebrand(state.castMembers),
    locations: rebrand(state.locations),
    requirements: rebrand(state.requirements),
    shootDays: rebrand(state.shootDays),
    callSheets: rebrand(state.callSheets),
    tasks: rebrand(state.tasks),
  };
};

const aChangeRequest = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: "CR-001",
  productionId: DEMO,
  type: "CAST_UNAVAILABLE",
  rawText: "Sarah cannot shoot Friday.",
  payload: {
    type: "CAST_UNAVAILABLE",
    castId: DEMO_MOVIE_IDS.cast.sarah,
    unavailable: { start: "2026-09-18", end: "2026-09-18" },
  },
  correlationId: "corr-001",
  createdBy: "coordinator@example.test",
  createdAt: "2026-09-10T11:03:00.000Z",
  ...overrides,
});

const aProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: "P-104",
  productionId: DEMO,
  changeRequestId: "CR-001",
  baseProductionVersion: 1,
  operations: [
    {
      type: "MOVE_SCENES",
      sceneIds: [DEMO_MOVIE_IDS.scenes.s07],
      fromShootDayId: DEMO_MOVIE_IDS.shootDays.friday,
      toShootDayId: DEMO_MOVIE_IDS.shootDays.monday,
    },
  ],
  impacts: [],
  conflicts: [],
  warnings: [],
  validationStatus: "VALID",
  status: "AWAITING_APPROVAL",
  digest: "a".repeat(64),
  summary: "Move Scene 07 to Monday.",
  createdAt: "2026-09-10T11:04:00.000Z",
  ...overrides,
});

const anApproval = (overrides: Partial<Approval> = {}): Approval => ({
  id: "A-77",
  productionId: DEMO,
  proposalId: "P-104",
  proposalDigest: "a".repeat(64),
  productionVersion: 1,
  approvedBy: "coordinator@example.test",
  decision: "APPROVE",
  createdAt: "2026-09-10T11:05:00.000Z",
  ...overrides,
});

const anAuditEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "AE-1",
  productionId: DEMO,
  actorType: "USER",
  action: "CHANGE_REQUEST_SUBMITTED",
  createdAt: "2026-09-10T11:03:00.000Z",
  ...overrides,
});

export const describeRepositoryContract = (
  adapterName: string,
  createRepositories: RepositoryFactory,
): void => {
  describe(`${adapterName} repository contract`, () => {
    let repositories: RepositorySet;
    let reopen: (() => Promise<RepositorySet>) | undefined;

    beforeEach(async () => {
      const created = await createRepositories();
      repositories = created.repositories;
      reopen = created.reopen;
    });

    describe("production state", () => {
      it("returns null for a production it has never seen", async () => {
        expect(await repositories.productions.loadState("PROD-UNKNOWN")).toBeNull();
      });

      it("stores and returns a seeded production", async () => {
        await repositories.productions.save(demoState());
        const loaded = await repositories.productions.loadState(DEMO);

        expect(loaded?.production.name).toBe("Demo Movie");
        expect(loaded?.scenes).toHaveLength(4);
        expect(loaded?.shootDays).toHaveLength(3);
      });

      it("does not hand out a reference a caller can mutate", async () => {
        await repositories.productions.save(demoState());
        const first = await repositories.productions.loadState(DEMO);
        (first as unknown as { scenes: unknown[] }).scenes.length = 0;

        expect((await repositories.productions.loadState(DEMO))?.scenes).toHaveLength(4);
      });

      it("keeps two productions apart", async () => {
        await repositories.productions.save(demoState());
        await repositories.productions.save(foreignState());

        expect((await repositories.productions.loadState(DEMO))?.production.name).toBe(
          "Demo Movie",
        );
        expect((await repositories.productions.loadState(OTHER_PRODUCTION))?.production.name).toBe(
          "Other Movie",
        );
      });

      it("refuses to seed a production holding another production's entities", async () => {
        const mixed = demoState();
        const contaminated: ProductionState = {
          ...mixed,
          scenes: mixed.scenes.map((scene, index) =>
            index === 0 ? { ...scene, productionId: OTHER_PRODUCTION } : scene,
          ),
        };

        await expect(repositories.productions.save(contaminated)).rejects.toBeInstanceOf(
          ProductionIsolationError,
        );
      });
    });

    describe("commit", () => {
      beforeEach(async () => {
        await repositories.productions.save(demoState());
      });

      it("applies the writes and increments the production version", async () => {
        const before = await repositories.productions.loadState(DEMO);
        const friday = before?.shootDays.find((day) => day.id === DEMO_MOVIE_IDS.shootDays.friday);

        const outcome = await repositories.productions.commit({
          productionId: DEMO,
          expectedVersion: 1,
          shootDays: [{ ...friday!, sceneIds: [DEMO_MOVIE_IDS.scenes.s12] }],
        });

        expect(outcome).toEqual({ status: "COMMITTED", productionVersion: 2 });

        const after = await repositories.productions.loadState(DEMO);
        expect(after?.production.version).toBe(2);
        expect(
          after?.shootDays.find((day) => day.id === DEMO_MOVIE_IDS.shootDays.friday)?.sceneIds,
        ).toEqual([DEMO_MOVIE_IDS.scenes.s12]);
        expect(after?.shootDays).toHaveLength(3);
      });

      it("inserts a record that did not exist before", async () => {
        await repositories.productions.commit({
          productionId: DEMO,
          expectedVersion: 1,
          tasks: [
            {
              id: "T-900",
              productionId: DEMO,
              title: "Source a red car for Scene 18",
              relatedEntityType: "SCENE",
              relatedEntityId: DEMO_MOVIE_IDS.scenes.s18,
              status: "OPEN",
            },
          ],
        });

        const after = await repositories.productions.loadState(DEMO);
        expect(after?.tasks).toHaveLength(5);
        expect(after?.tasks.some((task) => task.id === "T-900")).toBe(true);
      });

      it("reports a version mismatch and changes nothing", async () => {
        const outcome = await repositories.productions.commit({
          productionId: DEMO,
          expectedVersion: 99,
          tasks: [
            {
              id: "T-901",
              productionId: DEMO,
              title: "Should never be written",
              relatedEntityType: "SCENE",
              relatedEntityId: DEMO_MOVIE_IDS.scenes.s18,
              status: "OPEN",
            },
          ],
        });

        expect(outcome).toEqual({ status: "VERSION_MISMATCH", expected: 99, actual: 1 });

        const after = await repositories.productions.loadState(DEMO);
        expect(after?.production.version).toBe(1);
        expect(after?.tasks).toHaveLength(4);
      });

      it("refuses to commit an entity belonging to another production", async () => {
        await expect(
          repositories.productions.commit({
            productionId: DEMO,
            expectedVersion: 1,
            tasks: [
              {
                id: "T-902",
                productionId: OTHER_PRODUCTION,
                title: "Smuggled in from another production",
                relatedEntityType: "SCENE",
                relatedEntityId: DEMO_MOVIE_IDS.scenes.s18,
                status: "OPEN",
              },
            ],
          }),
        ).rejects.toBeInstanceOf(ProductionIsolationError);

        expect((await repositories.productions.loadState(DEMO))?.production.version).toBe(1);
      });

      it("rejects a commit against a production that was never seeded", async () => {
        await expect(
          repositories.productions.commit({ productionId: "PROD-UNKNOWN", expectedVersion: 0 }),
        ).rejects.toThrow(/ENTITY_NOT_FOUND/u);
      });

      it("serialises concurrent commits so only the first version wins", async () => {
        const results = await Promise.allSettled([
          repositories.productions.commit({ productionId: DEMO, expectedVersion: 1 }),
          repositories.productions.commit({ productionId: DEMO, expectedVersion: 1 }),
        ]);

        const outcomes = results.map((result) =>
          result.status === "fulfilled" ? result.value.status : "REJECTED",
        );

        expect(outcomes.filter((status) => status === "COMMITTED")).toHaveLength(1);
        expect(outcomes.filter((status) => status === "VERSION_MISMATCH")).toHaveLength(1);
        expect((await repositories.productions.loadState(DEMO))?.production.version).toBe(2);
      });
    });

    describe("change requests, proposals, and approvals", () => {
      it("round-trips a change request", async () => {
        await repositories.changeRequests.save(aChangeRequest());
        const found = await repositories.changeRequests.findById(DEMO, "CR-001");

        expect(found?.rawText).toBe("Sarah cannot shoot Friday.");
      });

      it("hides a change request from another production", async () => {
        await repositories.changeRequests.save(aChangeRequest());
        expect(await repositories.changeRequests.findById(OTHER_PRODUCTION, "CR-001")).toBeNull();
      });

      it("round-trips a proposal and finds it by status", async () => {
        await repositories.proposals.save(aProposal());
        await repositories.proposals.save(aProposal({ id: "P-105", status: "REJECTED" }));

        expect((await repositories.proposals.findById(DEMO, "P-104"))?.summary).toBe(
          "Move Scene 07 to Monday.",
        );
        expect(
          (await repositories.proposals.listByStatus(DEMO, "AWAITING_APPROVAL")).map(
            (proposal) => proposal.id,
          ),
        ).toEqual(["P-104"]);
      });

      it("updates a proposal in place rather than duplicating it", async () => {
        await repositories.proposals.save(aProposal());
        await repositories.proposals.save(aProposal({ status: "APPLIED" }));

        expect(await repositories.proposals.listByStatus(DEMO, "AWAITING_APPROVAL")).toEqual([]);
        expect((await repositories.proposals.findById(DEMO, "P-104"))?.status).toBe("APPLIED");
      });

      it("does not list another production's proposals", async () => {
        await repositories.proposals.save(aProposal());
        expect(
          await repositories.proposals.listByStatus(OTHER_PRODUCTION, "AWAITING_APPROVAL"),
        ).toEqual([]);
      });

      it("finds an approval by its proposal", async () => {
        await repositories.approvals.save(anApproval());

        expect((await repositories.approvals.findByProposalId(DEMO, "P-104"))?.id).toBe("A-77");
        expect((await repositories.approvals.findById(DEMO, "A-77"))?.decision).toBe("APPROVE");
      });

      it("returns null while a proposal has no decision", async () => {
        expect(await repositories.approvals.findByProposalId(DEMO, "P-104")).toBeNull();
      });

      it("hides an approval from another production", async () => {
        await repositories.approvals.save(anApproval());
        expect(await repositories.approvals.findByProposalId(OTHER_PRODUCTION, "P-104")).toBeNull();
      });
    });

    describe("audit events", () => {
      it("returns the newest first, because that is what an operator asks for", async () => {
        await repositories.auditEvents.append(anAuditEvent({ id: "AE-1", action: "FIRST" }));
        await repositories.auditEvents.append(anAuditEvent({ id: "AE-2", action: "SECOND" }));

        expect((await repositories.auditEvents.list(DEMO)).map((event) => event.action)).toEqual([
          "SECOND",
          "FIRST",
        ]);
      });

      it("honours a limit", async () => {
        await repositories.auditEvents.append(anAuditEvent({ id: "AE-1" }));
        await repositories.auditEvents.append(anAuditEvent({ id: "AE-2" }));

        expect(await repositories.auditEvents.list(DEMO, { limit: 1 })).toHaveLength(1);
      });

      it("keeps another production's events out of the trail", async () => {
        await repositories.auditEvents.append(anAuditEvent());
        await repositories.auditEvents.append(
          anAuditEvent({ id: "AE-2", productionId: OTHER_PRODUCTION }),
        );

        expect(await repositories.auditEvents.list(DEMO)).toHaveLength(1);
      });
    });

    describe("idempotency records", () => {
      const record = {
        key: "apply:P-104:aaaaaaaaaaaaaaaa",
        proposalId: "P-104",
        proposalDigest: "a".repeat(64),
        productionVersionAfter: 2,
      };

      it("returns null for a key it has not seen", async () => {
        expect(await repositories.idempotency.find(DEMO, record.key)).toBeNull();
      });

      it("round-trips a record", async () => {
        await repositories.idempotency.save(DEMO, record);
        expect(await repositories.idempotency.find(DEMO, record.key)).toEqual(record);
      });

      it("scopes keys to a production, so two tenants can reuse a key safely", async () => {
        await repositories.idempotency.save(DEMO, record);
        expect(await repositories.idempotency.find(OTHER_PRODUCTION, record.key)).toBeNull();
      });
    });

    describe("durability", () => {
      it("makes writes visible to a second handle on the same storage", async () => {
        if (reopen === undefined) {
          expect(reopen).toBeUndefined();
          return;
        }

        await repositories.productions.save(demoState());
        await repositories.changeRequests.save(aChangeRequest());

        const reopened = await reopen();
        expect((await reopened.productions.loadState(DEMO))?.scenes).toHaveLength(4);
        expect((await reopened.changeRequests.findById(DEMO, "CR-001"))?.id).toBe("CR-001");
      });
    });
  });
};
