import { describe, expect, it } from "vitest";

import type { ProposedOperation, Task } from "@pca/contracts";
import { EXPLANATION_MAX_LENGTH, VERIFICATION_CHECK_NAME_MAX_LENGTH } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { onDay } from "@pca/test-support";

import { indexProduction, type ProductionState } from "../src/production-state";
import { applyOperations, simulationIds } from "../src/simulation";
import {
  CHECK_NAME_FRAGMENT_MAX_LENGTH,
  clip,
  verifyAvailabilityHonoured,
  verifyInvariantsHold,
  verifyOperationsApplied,
} from "../src/verification";

const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday } = DEMO_MOVIE_DATES;

const golden1: ProposedOperation[] = [
  { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.monday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.monday },
];

const golden3: ProposedOperation[] = [
  { type: "ADD_SCENE_REQUIREMENT", sceneId: scenes.s18, requirementType: "PROP", name: "red car" },
  {
    type: "CREATE_PREPARATION_TASK",
    title: "Source a red car for Scene 18",
    relatedEntityType: "SCENE",
    relatedEntityId: scenes.s18,
  },
];

const applied = (operations: ProposedOperation[]) =>
  indexProduction(applyOperations(createDemoMovie(), operations, simulationIds()).state);

const untouched = () => indexProduction(createDemoMovie());

describe("verifyOperationsApplied", () => {
  it("passes every GOLDEN-1 operation against the world it produced, with readable names", () => {
    const checks = verifyOperationsApplied(applied(golden1), golden1);
    expect(checks.map((entry) => [entry.name, entry.passed])).toEqual([
      ["1. Sarah recorded unavailable 2026-09-18 to 2026-09-18", true],
      ["2. Scene 07, Scene 12 moved to 2026-09-21", true],
      ["3. Call sheet CS-2026-09-18 is a draft", true],
      ["4. Call sheet CS-2026-09-21 is a draft", true],
    ]);
  });

  it("fails every GOLDEN-1 operation against the untouched world, and says why", () => {
    const checks = verifyOperationsApplied(untouched(), golden1);
    expect(checks.map((entry) => entry.passed)).toEqual([false, false, false, false]);
    expect(checks[1]?.detail).toBe("Scene 07, Scene 12 not on 2026-09-21, or still on 2026-09-18.");
    expect(checks[2]?.detail).toBe("The call sheet is still PUBLISHED.");
  });

  it("passes GOLDEN-3 and names the created records", () => {
    const checks = verifyOperationsApplied(applied(golden3), golden3);
    expect(checks.map((entry) => entry.passed)).toEqual([true, true]);
    expect(checks[0]?.detail).toBe("Requirement SIM-REQ-1 exists and is listed on the scene.");
    expect(checks[1]?.detail).toBe(
      'Task SIM-T-1 "Source a red car for Scene 18" is open and linked to SCENE S18.',
    );
  });

  it("notices a requirement that exists but is not listed on the scene", () => {
    const state = applyOperations(createDemoMovie(), golden3, simulationIds()).state;
    const unwired = indexProduction({
      ...state,
      scenes: state.scenes.map((scene) =>
        scene.id === scenes.s18 ? { ...scene, requirementIds: [] } : scene,
      ),
    });
    const [check] = verifyOperationsApplied(unwired, [golden3[0]!]);
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("does not list it");
  });

  it("does not count a completed task as satisfying a preparation task", () => {
    const state = applyOperations(createDemoMovie(), golden3, simulationIds()).state;
    const done = indexProduction({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === "SIM-T-1" ? { ...task, status: "DONE" } : task,
      ),
    });
    expect(verifyOperationsApplied(done, [golden3[1]!])[0]?.passed).toBe(false);
  });

  it("fails a move when a scene is on the target but also still on the source", () => {
    const state = applyOperations(createDemoMovie(), [golden1[1]!], simulationIds()).state;
    const doubled = indexProduction({
      ...state,
      shootDays: state.shootDays.map((day) =>
        day.id === shootDays.friday ? { ...day, sceneIds: [scenes.s07] } : day,
      ),
    });
    const [check] = verifyOperationsApplied(doubled, [golden1[1]!]);
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("Scene 07");
  });

  it("verifies a location recording", () => {
    const record: ProposedOperation = {
      type: "RECORD_LOCATION_UNAVAILABILITY",
      locationId: locations.warehouse,
      unavailable: onDay(friday),
    };
    expect(verifyOperationsApplied(applied([record]), [record])[0]?.passed).toBe(true);
    expect(verifyOperationsApplied(untouched(), [record])[0]?.passed).toBe(false);
  });

  it("reports a missing entity as a failed check rather than throwing", () => {
    const checks = verifyOperationsApplied(untouched(), [
      { ...golden1[0]!, castId: "CAST-GHOST" } as ProposedOperation,
      { type: "MARK_CALL_SHEET_STALE", callSheetId: "CS-GHOST" },
    ]);
    expect(checks.map((entry) => entry.detail)).toEqual([
      "Cast member CAST-GHOST does not exist.",
      "Call sheet CS-GHOST does not exist.",
    ]);
  });
});

describe("TASK-912: check names stay within the MCP output contract whatever the input says", () => {
  const longTitle = "Source ".padEnd(300, "x");
  const longTask: ProposedOperation = {
    type: "CREATE_PREPARATION_TASK",
    title: longTitle,
    relatedEntityType: "SCENE",
    relatedEntityId: scenes.s18,
  };

  it("clips a 300-character task title in the name and keeps the whole title in the detail", () => {
    const [entry] = verifyOperationsApplied(applied([longTask]), [longTask]);
    expect(entry?.passed).toBe(true);
    expect(entry?.name.length).toBeLessThanOrEqual(VERIFICATION_CHECK_NAME_MAX_LENGTH);
    expect(entry?.name).toBe(`1. Open task "${longTitle.slice(0, 29)}\u2026" exists`);
    expect(entry?.detail).toContain(`"${longTitle}"`);
  });

  it("clips a 200-character cast name in both the operation check and the availability check", () => {
    const longName = "Sarah ".padEnd(200, "y");
    const state: ProductionState = {
      ...createDemoMovie(),
      castMembers: createDemoMovie().castMembers.map((member) =>
        member.id === cast.sarah ? { ...member, name: longName } : member,
      ),
    };
    const index = indexProduction(applyOperations(state, golden1, simulationIds()).state);
    const names = [
      ...verifyOperationsApplied(index, golden1),
      ...verifyAvailabilityHonoured(index, golden1),
    ].map((entry) => entry.name);

    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(VERIFICATION_CHECK_NAME_MAX_LENGTH);
    }
    const fragment = `${longName.slice(0, CHECK_NAME_FRAGMENT_MAX_LENGTH - 1)}\u2026`;
    expect(names[0]).toBe(`1. ${fragment} recorded unavailable 2026-09-18 to 2026-09-18`);
    expect(names[4]).toBe(
      `No scene requiring ${fragment} remains scheduled while ${fragment} is unavailable`,
    );
  });

  it("clips the invariant detail to the explanation limit when there is too much to say", () => {
    const orphans: Task[] = Array.from({ length: 60 }, (_, position) => ({
      id: `T-ORPHAN-${position}`,
      productionId: DEMO_MOVIE_IDS.production,
      title: `Orphan task number ${position} with a deliberately long title to fill the detail`,
      relatedEntityType: "SCENE",
      relatedEntityId: `S-MISSING-${position}`,
      status: "OPEN",
    }));
    const entry = verifyInvariantsHold(
      indexProduction({ ...createDemoMovie(), tasks: [...createDemoMovie().tasks, ...orphans] }),
    );
    expect(entry.passed).toBe(false);
    expect(entry.detail?.length).toBe(EXPLANATION_MAX_LENGTH);
    expect(entry.detail?.endsWith("\u2026")).toBe(true);
    expect(entry.detail?.startsWith("INV-3: Task")).toBe(true);
  });

  it("clip leaves text at the limit alone and marks a cut so it is never mistaken for the whole", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("abcd", 3)).toBe("ab\u2026");
    expect(clip("abcd", 3)).toHaveLength(3);
    expect(clip("x".repeat(121), 120)).toHaveLength(120);
  });
});

describe("verifyAvailabilityHonoured", () => {
  it("confirms, in the scenario's own words, that nobody unavailable is still scheduled", () => {
    const checks = verifyAvailabilityHonoured(applied(golden1), golden1);
    expect(checks).toEqual([
      {
        name: "No scene requiring Sarah remains scheduled while Sarah is unavailable",
        passed: true,
        detail: "No scene requiring Sarah falls inside 2026-09-18 to 2026-09-18.",
      },
    ]);
  });

  it("names the scenes still inside the window when the remedy did not land", () => {
    const factOnly = applied([golden1[0]!]);
    const [check] = verifyAvailabilityHonoured(factOnly, golden1);
    expect(check?.passed).toBe(false);
    expect(check?.detail).toBe("Scene 07, Scene 12 still scheduled inside the window.");
  });

  it("produces no availability check for a proposal that records no fact", () => {
    expect(verifyAvailabilityHonoured(applied(golden3), golden3)).toEqual([]);
  });
});

describe("verifyInvariantsHold", () => {
  it("passes on the applied GOLDEN-1 world", () => {
    expect(verifyInvariantsHold(applied(golden1)).passed).toBe(true);
  });

  it("fails, listing each violation, when the fact is recorded without the remedy", () => {
    const check = verifyInvariantsHold(applied([golden1[0]!]));
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("INV-1: Scene 07");
    expect(check.detail).toContain("INV-1: Scene 12");
  });
});
