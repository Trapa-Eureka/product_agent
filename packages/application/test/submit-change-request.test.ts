import { beforeEach, describe, expect, it } from "vitest";

import type { TypedChange } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { createMemoryStore, type MemoryStore } from "@pca/memory-store";
import { fixedClock, sequentialIds } from "@pca/test-support";

import { createSubmitChangeRequest, type SubmitChangeRequest } from "../src";

const DEMO = DEMO_MOVIE_IDS.production;
const NOW = "2026-09-10T11:03:00.000Z";

const sarahOnFriday: TypedChange = {
  type: "CAST_UNAVAILABLE",
  castId: DEMO_MOVIE_IDS.cast.sarah,
  unavailable: { start: DEMO_MOVIE_DATES.friday, end: DEMO_MOVIE_DATES.friday },
};

describe("submitChangeRequest", () => {
  let store: MemoryStore;
  let submit: SubmitChangeRequest;

  beforeEach(async () => {
    store = createMemoryStore({ now: () => NOW });
    await store.productions.save(createDemoMovie());
    submit = createSubmitChangeRequest({
      repositories: store,
      clock: fixedClock(NOW),
      ids: sequentialIds(),
    });
  });

  describe("happy path", () => {
    it("persists the raw sentence and the typed change under a generated ID", async () => {
      const result = await submit({
        productionId: DEMO,
        rawText: "Sarah cannot shoot Friday.",
        change: sarahOnFriday,
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        id: "CR-1",
        productionId: DEMO,
        type: "CAST_UNAVAILABLE",
        rawText: "Sarah cannot shoot Friday.",
        payload: sarahOnFriday,
        correlationId: "corr-1",
        createdBy: "coordinator@example.test",
        createdAt: NOW,
      });
      expect(await store.changeRequests.findById(DEMO, "CR-1")).toEqual(result.value);
    });

    it("keeps a correlation ID handed in by the transport", async () => {
      const result = await submit({
        productionId: DEMO,
        rawText: "Sarah cannot shoot Friday.",
        change: sarahOnFriday,
        createdBy: "coordinator@example.test",
        correlationId: "http-req-42",
      });

      expect(result.ok && result.value.correlationId).toBe("http-req-42");
    });

    it("writes one audit event filed under the entity the change is about", async () => {
      await submit({
        productionId: DEMO,
        rawText: "Sarah cannot shoot Friday.",
        change: sarahOnFriday,
        createdBy: "coordinator@example.test",
      });

      expect(await store.auditEvents.list(DEMO)).toEqual([
        {
          id: "AE-1",
          productionId: DEMO,
          actorType: "USER",
          actorId: "coordinator@example.test",
          action: "CHANGE_REQUEST_SUBMITTED",
          entityType: "CAST_MEMBER",
          entityId: DEMO_MOVIE_IDS.cast.sarah,
          correlationId: "corr-1",
          metadata: {
            changeRequestId: "CR-1",
            changeType: "CAST_UNAVAILABLE",
            rawText: "Sarah cannot shoot Friday.",
          },
          createdAt: NOW,
        },
      ]);
    });

    it("trims surrounding whitespace from the sentence but changes nothing else", async () => {
      const result = await submit({
        productionId: DEMO,
        rawText: "  Scene 18 now needs a red car.  ",
        change: {
          type: "SCENE_REQUIREMENT_CHANGED",
          sceneId: DEMO_MOVIE_IDS.scenes.s18,
          requirement: { type: "PROP", name: "red car" },
        },
        createdBy: "coordinator@example.test",
      });

      expect(result.ok && result.value.rawText).toBe("Scene 18 now needs a red car.");
    });

    it.each<[string, TypedChange, string]>([
      [
        "a location change",
        {
          type: "LOCATION_UNAVAILABLE",
          locationId: DEMO_MOVIE_IDS.locations.warehouse,
          unavailable: { start: DEMO_MOVIE_DATES.friday, end: DEMO_MOVIE_DATES.friday },
        },
        "LOCATION",
      ],
      [
        "a schedule change",
        {
          type: "SCHEDULE_CHANGED",
          sceneIds: [DEMO_MOVIE_IDS.scenes.s07, DEMO_MOVIE_IDS.scenes.s12],
          toShootDayId: DEMO_MOVIE_IDS.shootDays.monday,
        },
        "SHOOT_DAY",
      ],
    ])("accepts %s and files it under the right subject", async (_label, change, subject) => {
      const result = await submit({
        productionId: DEMO,
        rawText: "some change",
        change,
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(true);
      expect((await store.auditEvents.list(DEMO))[0]?.entityType).toBe(subject);
    });
  });

  describe("refusals", () => {
    const expectNothingPersisted = async (): Promise<void> => {
      expect(await store.changeRequests.findById(DEMO, "CR-1")).toBeNull();
      expect(await store.auditEvents.list(DEMO)).toEqual([]);
    };

    it("refuses an unknown production and persists nothing", async () => {
      const result = await submit({
        productionId: "PROD-GHOST",
        rawText: "Sarah cannot shoot Friday.",
        change: sarahOnFriday,
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("ENTITY_NOT_FOUND");
      expect(result.error.nextStep).toContain("get_production");
      await expectNothingPersisted();
    });

    it("refuses a cast member this production does not have, naming the lookup tool", async () => {
      const result = await submit({
        productionId: DEMO,
        rawText: "Sara cannot shoot Friday.",
        change: { ...sarahOnFriday, castId: "CAST-SARA" },
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "ENTITY_NOT_FOUND",
        actual: "CAST-SARA",
        correlationId: "corr-1",
      });
      expect(result.error.message).toContain("cast member CAST-SARA");
      expect(result.error.nextStep).toContain("find_cast");
      await expectNothingPersisted();
    });

    it("refuses an ID that exists only in another production", async () => {
      const other = createDemoMovie();
      const rebadged = {
        ...other,
        production: { ...other.production, id: "PROD-OTHER" },
        castMembers: [
          {
            ...other.castMembers[0]!,
            id: "CAST-ZOE",
            name: "Zoe",
            productionId: "PROD-OTHER",
          },
        ],
        scenes: [],
        locations: other.locations.map((location) => ({ ...location, productionId: "PROD-OTHER" })),
        requirements: [],
        shootDays: [],
        callSheets: [],
        tasks: [],
      };
      await store.productions.save(rebadged);

      const result = await submit({
        productionId: DEMO,
        rawText: "Zoe cannot shoot Friday.",
        change: { ...sarahOnFriday, castId: "CAST-ZOE" },
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("ENTITY_NOT_FOUND");
      await expectNothingPersisted();
    });

    it.each<[string, TypedChange]>([
      [
        "an unknown location",
        {
          type: "LOCATION_UNAVAILABLE",
          locationId: "LOC-ROOFTOP",
          unavailable: { start: DEMO_MOVIE_DATES.friday, end: DEMO_MOVIE_DATES.friday },
        },
      ],
      [
        "an unknown scene",
        {
          type: "SCENE_REQUIREMENT_CHANGED",
          sceneId: "S99",
          requirement: { type: "PROP", name: "red car" },
        },
      ],
      [
        "a schedule change naming one unknown scene among known ones",
        {
          type: "SCHEDULE_CHANGED",
          sceneIds: [DEMO_MOVIE_IDS.scenes.s07, "S99"],
          toShootDayId: DEMO_MOVIE_IDS.shootDays.monday,
        },
      ],
      [
        "a schedule change to an unknown shoot day",
        {
          type: "SCHEDULE_CHANGED",
          sceneIds: [DEMO_MOVIE_IDS.scenes.s07],
          toShootDayId: "SD-2026-12-25",
        },
      ],
    ])("refuses %s", async (_label, change) => {
      const result = await submit({
        productionId: DEMO,
        rawText: "some change",
        change,
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("ENTITY_NOT_FOUND");
      await expectNothingPersisted();
    });

    it("refuses a malformed change even though the type checker was bypassed", async () => {
      const result = await submit({
        productionId: DEMO,
        rawText: "Sarah cannot shoot Friday.",
        change: { type: "CAST_UNAVAILABLE", castName: "Sarah" } as unknown as TypedChange,
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.nextStep).toContain("TypedChange");
      await expectNothingPersisted();
    });

    it("refuses an empty sentence, because the audit trail must show what was said", async () => {
      const result = await submit({
        productionId: DEMO,
        rawText: "   ",
        change: sarahOnFriday,
        createdBy: "coordinator@example.test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_INPUT");
      await expectNothingPersisted();
    });
  });
});
