import type {
  CallSheet,
  CastMember,
  Location,
  Production,
  Requirement,
  Scene,
  ShootDay,
  Task,
} from "@pca/contracts";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS } from "./ids";

/**
 * The Demo Movie fixture (TESTING.md §3).
 *
 * One canonical production that satisfies the preconditions of all three golden
 * scenarios at once:
 *
 * - Scenes 07 and 12 are on Friday, so a cast or location problem on Friday has
 *   something to affect.
 * - Sarah and the Warehouse are both available on Friday, so each scenario
 *   introduces the conflict rather than inheriting it.
 * - Monday is a genuine alternative for the Warehouse scenes: the Warehouse is
 *   free, and so are Sarah and John.
 * - Scene 18 has no red-car requirement, so adding one is a real change.
 * - Every shoot day has a call sheet, so downstream impact is visible.
 *
 * The state is deliberately valid: every invariant passes before a scenario
 * touches it. A fixture that starts out broken makes every later failure
 * ambiguous.
 */

const PRODUCTION_ID = DEMO_MOVIE_IDS.production;
const CREATED_AT = "2026-09-01T00:00:00.000Z";

/**
 * Shape of the fixture, kept separate from the domain's `ProductionState` so
 * this package stays free of a dependency on the domain.
 */
export type DemoMovieFixture = {
  production: Production;
  scenes: Scene[];
  castMembers: CastMember[];
  locations: Location[];
  requirements: Requirement[];
  shootDays: ShootDay[];
  callSheets: CallSheet[];
  tasks: Task[];
};

/**
 * Builds a fresh Demo Movie.
 *
 * A factory rather than a shared constant: scenario tests mutate their copy, and
 * a test that quietly corrupts the fixture for every later test is a debugging
 * cost nobody should pay.
 */
export const createDemoMovie = (): DemoMovieFixture => ({
  production: {
    id: PRODUCTION_ID,
    name: "Demo Movie",
    timezone: "Asia/Manila",
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },

  castMembers: [
    {
      id: DEMO_MOVIE_IDS.cast.sarah,
      productionId: PRODUCTION_ID,
      name: "Sarah",
      roleName: "Nadia",
      // Available all three shoot days. Scenario A introduces the conflict.
      unavailable: [],
    },
    {
      id: DEMO_MOVIE_IDS.cast.john,
      productionId: PRODUCTION_ID,
      name: "John",
      roleName: "Emil",
      unavailable: [],
    },
    {
      id: DEMO_MOVIE_IDS.cast.mike,
      productionId: PRODUCTION_ID,
      name: "Mike",
      roleName: "Barista",
      // Outside the shoot week, so the availability model is exercised without
      // colliding with any scenario.
      unavailable: [{ start: "2026-09-25", end: "2026-09-26" }],
    },
  ],

  locations: [
    {
      id: DEMO_MOVIE_IDS.locations.warehouse,
      productionId: PRODUCTION_ID,
      name: "Warehouse",
      // Available Friday and Monday. Scenario B introduces the conflict.
      unavailable: [],
    },
    {
      id: DEMO_MOVIE_IDS.locations.cafe,
      productionId: PRODUCTION_ID,
      name: "Cafe",
      unavailable: [],
    },
    {
      id: DEMO_MOVIE_IDS.locations.apartment,
      productionId: PRODUCTION_ID,
      name: "Apartment",
      // Scene 22 shoots here on Monday, so a Tuesday block is harmless and
      // keeps the location model from being uniformly empty.
      unavailable: [{ start: DEMO_MOVIE_DATES.tuesday, end: DEMO_MOVIE_DATES.tuesday }],
    },
  ],

  scenes: [
    {
      id: DEMO_MOVIE_IDS.scenes.s07,
      productionId: PRODUCTION_ID,
      sceneNumber: "07",
      title: "Standoff at the loading dock",
      locationId: DEMO_MOVIE_IDS.locations.warehouse,
      requiredCastIds: [DEMO_MOVIE_IDS.cast.sarah, DEMO_MOVIE_IDS.cast.john],
      requirementIds: [DEMO_MOVIE_IDS.requirements.crowbar],
      estimatedMinutes: 120,
    },
    {
      id: DEMO_MOVIE_IDS.scenes.s12,
      productionId: PRODUCTION_ID,
      sceneNumber: "12",
      title: "Nadia searches the crates",
      locationId: DEMO_MOVIE_IDS.locations.warehouse,
      requiredCastIds: [DEMO_MOVIE_IDS.cast.sarah],
      requirementIds: [],
      estimatedMinutes: 75,
    },
    {
      id: DEMO_MOVIE_IDS.scenes.s18,
      productionId: PRODUCTION_ID,
      sceneNumber: "18",
      title: "Coffee before the handover",
      locationId: DEMO_MOVIE_IDS.locations.cafe,
      requiredCastIds: [DEMO_MOVIE_IDS.cast.mike],
      // No requirements. Scenario C adds the red car.
      requirementIds: [],
      estimatedMinutes: 45,
    },
    {
      id: DEMO_MOVIE_IDS.scenes.s22,
      productionId: PRODUCTION_ID,
      sceneNumber: "22",
      title: "Emil packs in the rain",
      locationId: DEMO_MOVIE_IDS.locations.apartment,
      requiredCastIds: [DEMO_MOVIE_IDS.cast.john],
      requirementIds: [DEMO_MOVIE_IDS.requirements.raincoat],
      estimatedMinutes: 60,
    },
  ],

  requirements: [
    {
      id: DEMO_MOVIE_IDS.requirements.crowbar,
      productionId: PRODUCTION_ID,
      sceneId: DEMO_MOVIE_IDS.scenes.s07,
      type: "PROP",
      name: "crowbar",
      status: "NEEDED",
    },
    {
      id: DEMO_MOVIE_IDS.requirements.raincoat,
      productionId: PRODUCTION_ID,
      sceneId: DEMO_MOVIE_IDS.scenes.s22,
      type: "WARDROBE",
      name: "raincoat",
      status: "READY",
    },
  ],

  shootDays: [
    {
      id: DEMO_MOVIE_IDS.shootDays.friday,
      productionId: PRODUCTION_ID,
      date: DEMO_MOVIE_DATES.friday,
      sceneIds: [DEMO_MOVIE_IDS.scenes.s07, DEMO_MOVIE_IDS.scenes.s12],
      status: "CONFIRMED",
    },
    {
      id: DEMO_MOVIE_IDS.shootDays.monday,
      productionId: PRODUCTION_ID,
      date: DEMO_MOVIE_DATES.monday,
      sceneIds: [DEMO_MOVIE_IDS.scenes.s22],
      status: "CONFIRMED",
    },
    {
      id: DEMO_MOVIE_IDS.shootDays.tuesday,
      productionId: PRODUCTION_ID,
      date: DEMO_MOVIE_DATES.tuesday,
      sceneIds: [DEMO_MOVIE_IDS.scenes.s18],
      status: "CONFIRMED",
    },
  ],

  // Every day is published, so any scheduling change produces a real call sheet
  // to invalidate rather than a silent no-op.
  callSheets: [
    {
      id: DEMO_MOVIE_IDS.callSheets.friday,
      productionId: PRODUCTION_ID,
      shootDayId: DEMO_MOVIE_IDS.shootDays.friday,
      version: 1,
      status: "PUBLISHED",
    },
    {
      id: DEMO_MOVIE_IDS.callSheets.monday,
      productionId: PRODUCTION_ID,
      shootDayId: DEMO_MOVIE_IDS.shootDays.monday,
      version: 1,
      status: "PUBLISHED",
    },
    {
      id: DEMO_MOVIE_IDS.callSheets.tuesday,
      productionId: PRODUCTION_ID,
      shootDayId: DEMO_MOVIE_IDS.shootDays.tuesday,
      version: 1,
      status: "PUBLISHED",
    },
  ],

  tasks: [
    {
      id: DEMO_MOVIE_IDS.tasks.confirmFridayCrewCall,
      productionId: PRODUCTION_ID,
      title: "Confirm crew call for Friday",
      relatedEntityType: "SHOOT_DAY",
      relatedEntityId: DEMO_MOVIE_IDS.shootDays.friday,
      status: "OPEN",
    },
    {
      id: DEMO_MOVIE_IDS.tasks.distributeFridayCallSheet,
      productionId: PRODUCTION_ID,
      title: "Distribute Friday call sheet",
      relatedEntityType: "CALL_SHEET",
      relatedEntityId: DEMO_MOVIE_IDS.callSheets.friday,
      status: "OPEN",
    },
    {
      id: DEMO_MOVIE_IDS.tasks.prepCrowbar,
      productionId: PRODUCTION_ID,
      title: "Prep crowbar for Scene 07",
      relatedEntityType: "SCENE",
      relatedEntityId: DEMO_MOVIE_IDS.scenes.s07,
      status: "OPEN",
    },
    {
      id: DEMO_MOVIE_IDS.tasks.collectRaincoat,
      productionId: PRODUCTION_ID,
      title: "Collect raincoat from wardrobe",
      relatedEntityType: "REQUIREMENT",
      relatedEntityId: DEMO_MOVIE_IDS.requirements.raincoat,
      status: "DONE",
    },
  ],
});
