import { describe, expect, it } from "vitest";

import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { onDay, withCastUnavailable, withLocationUnavailable } from "@pca/test-support";

import { generateScheduleCandidates } from "../src/candidates";
import { indexProduction } from "../src/production-state";

const { cast, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;

const demo = () => indexProduction(createDemoMovie());
const warehouseScenes = [scenes.s07, scenes.s12];

describe("candidate days for the Warehouse scenes (GOLDEN-1 and GOLDEN-2 remedy)", () => {
  const generation = generateScheduleCandidates(demo(), { sceneIds: warehouseScenes });

  it("offers Monday and Tuesday, earliest first, and refuses Friday where they already sit", () => {
    expect(
      generation.candidates.map((candidate) => [candidate.shootDayId, candidate.date]),
    ).toEqual([
      [shootDays.monday, monday],
      [shootDays.tuesday, tuesday],
    ]);
    expect(generation.rejected).toEqual([
      {
        shootDayId: shootDays.friday,
        date: friday,
        reasons: ["A moving scene is already scheduled on 2026-09-18."],
      },
    ]);
  });

  it("keeps the group together: every candidate carries both scenes", () => {
    for (const candidate of generation.candidates) {
      expect(candidate.sceneIds).toEqual(warehouseScenes);
    }
  });

  it("warns that John is already booked on Monday, as the proposal view shows", () => {
    expect(generation.candidates[0]?.warnings).toEqual([
      "John is already required on 2026-09-21 for Scene 22.",
      "Call sheet CS-2026-09-21 is published and would need regeneration.",
    ]);
  });

  it("warns only about the call sheet on Tuesday, where nobody is double-booked", () => {
    expect(generation.candidates[1]?.warnings).toEqual([
      "Call sheet CS-2026-09-22 is published and would need regeneration.",
    ]);
  });

  it("offers the same days once Sarah's Friday conflict is recorded, and adds it to Friday's reasons", () => {
    const afterConflict = generateScheduleCandidates(
      indexProduction(withCastUnavailable(createDemoMovie(), cast.sarah, onDay(friday))),
      { sceneIds: warehouseScenes },
    );

    expect(afterConflict.candidates).toEqual(generation.candidates);
    expect(afterConflict.rejected[0]?.reasons).toEqual([
      "A moving scene is already scheduled on 2026-09-18.",
      "Sarah is unavailable on 2026-09-18 and is required by Scene 07.",
      "Sarah is unavailable on 2026-09-18 and is required by Scene 12.",
    ]);
  });
});

describe("refusals say why", () => {
  it("refuses Monday when Sarah cannot make it, and still offers Tuesday", () => {
    const index = indexProduction(
      withCastUnavailable(createDemoMovie(), cast.sarah, onDay(monday)),
    );
    const generation = generateScheduleCandidates(index, { sceneIds: warehouseScenes });

    expect(generation.candidates.map((candidate) => candidate.date)).toEqual([tuesday]);
    expect(generation.rejected.find((day) => day.date === monday)?.reasons).toEqual([
      "Sarah is unavailable on 2026-09-21 and is required by Scene 07.",
      "Sarah is unavailable on 2026-09-21 and is required by Scene 12.",
    ]);
  });

  it("refuses Tuesday when the Warehouse is closed", () => {
    const index = indexProduction(
      withLocationUnavailable(createDemoMovie(), locations.warehouse, onDay(tuesday)),
    );
    const generation = generateScheduleCandidates(index, { sceneIds: warehouseScenes });

    expect(generation.candidates.map((candidate) => candidate.date)).toEqual([monday]);
    expect(generation.rejected.find((day) => day.date === tuesday)?.reasons).toEqual([
      "Warehouse is unavailable on 2026-09-22 and is needed by Scene 07.",
      "Warehouse is unavailable on 2026-09-22 and is needed by Scene 12.",
    ]);
  });

  it("lists every reason against a day, not just the first", () => {
    const blocked = withLocationUnavailable(
      withCastUnavailable(createDemoMovie(), cast.john, onDay(tuesday)),
      locations.warehouse,
      onDay(tuesday),
    );
    const generation = generateScheduleCandidates(indexProduction(blocked), {
      sceneIds: [scenes.s07],
    });

    expect(generation.rejected.find((day) => day.date === tuesday)?.reasons).toHaveLength(2);
  });

  it("honours excluded dates and records the exclusion as the reason", () => {
    const generation = generateScheduleCandidates(demo(), {
      sceneIds: warehouseScenes,
      excludeDates: [monday],
    });

    expect(generation.candidates.map((candidate) => candidate.date)).toEqual([tuesday]);
    expect(generation.rejected.find((day) => day.date === monday)?.reasons).toEqual([
      "2026-09-21 was excluded by the request.",
    ]);
  });

  it("returns no candidates, and a reason for every day, when nothing fits", () => {
    const generation = generateScheduleCandidates(demo(), {
      sceneIds: warehouseScenes,
      excludeDates: [monday, tuesday],
    });

    expect(generation.candidates).toEqual([]);
    expect(generation.rejected).toHaveLength(3);
  });
});

describe("other scenes", () => {
  it("respects the Apartment's Tuesday closure when moving Scene 22", () => {
    const generation = generateScheduleCandidates(demo(), { sceneIds: [scenes.s22] });

    expect(generation.candidates.map((candidate) => candidate.date)).toEqual([friday]);
    expect(generation.rejected.map((day) => [day.date, day.reasons[0]])).toEqual([
      [monday, "A moving scene is already scheduled on 2026-09-21."],
      [tuesday, "Apartment is unavailable on 2026-09-22 and is needed by Scene 22."],
    ]);
  });

  it("refuses every day for a scene that does not exist, rather than throwing", () => {
    const generation = generateScheduleCandidates(demo(), { sceneIds: ["S99"] });

    expect(generation.candidates).toEqual([]);
    for (const day of generation.rejected) {
      expect(day.reasons).toContain("Scene S99 does not exist in this production.");
    }
  });
});

describe("purity", () => {
  it("is a pure function of its inputs", () => {
    expect(generateScheduleCandidates(demo(), { sceneIds: warehouseScenes })).toEqual(
      generateScheduleCandidates(demo(), { sceneIds: warehouseScenes }),
    );
  });

  it("does not mutate the snapshot", () => {
    const index = demo();
    const before = JSON.stringify(index.state);
    generateScheduleCandidates(index, { sceneIds: warehouseScenes, excludeDates: [monday] });
    expect(JSON.stringify(index.state)).toBe(before);
  });
});
