/**
 * Demo Movie identifiers.
 *
 * These IDs are part of the project's test contract, not an implementation
 * detail. Golden scenario tests, seed data, demo scripts, and screenshots all
 * name them, so changing one is a breaking change and the fixture integrity
 * test asserts the whole set.
 *
 * They are readable on purpose: a failing assertion should say `S07` and
 * `SD-2026-09-18`, not two opaque UUIDs a reader has to look up.
 */
export const DEMO_MOVIE_IDS = {
  production: "PROD-DEMO",

  cast: {
    sarah: "CAST-SARAH",
    john: "CAST-JOHN",
    mike: "CAST-MIKE",
  },

  locations: {
    warehouse: "LOC-WAREHOUSE",
    cafe: "LOC-CAFE",
    apartment: "LOC-APARTMENT",
  },

  scenes: {
    s07: "S07",
    s12: "S12",
    s18: "S18",
    s22: "S22",
  },

  shootDays: {
    friday: "SD-2026-09-18",
    monday: "SD-2026-09-21",
    tuesday: "SD-2026-09-22",
  },

  callSheets: {
    friday: "CS-2026-09-18",
    monday: "CS-2026-09-21",
    tuesday: "CS-2026-09-22",
  },

  requirements: {
    crowbar: "REQ-001",
    raincoat: "REQ-002",
  },

  tasks: {
    confirmFridayCrewCall: "T-001",
    distributeFridayCallSheet: "T-002",
    prepCrowbar: "T-003",
    collectRaincoat: "T-004",
  },
} as const;

/** The shoot dates, named by weekday because that is how a coordinator speaks. */
export const DEMO_MOVIE_DATES = {
  friday: "2026-09-18",
  monday: "2026-09-21",
  tuesday: "2026-09-22",
} as const;

export type DemoMovieIds = typeof DEMO_MOVIE_IDS;
