import { describe, expect, it } from "vitest";

import { guardModelPort } from "@pca/application";
import type { InterpretChangeInput, InterpretationContext } from "@pca/contracts";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";

import {
  createRuleModelAdapter,
  explainWithRules,
  interpretWithRules,
  rankWithRules,
} from "../src";

const { cast, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday, tuesday } = DEMO_MOVIE_DATES;

const demo = createDemoMovie();
const context: InterpretationContext = {
  castMembers: demo.castMembers.map((member) => ({
    id: member.id,
    name: member.name,
    ...(member.roleName === undefined ? {} : { roleName: member.roleName }),
  })),
  locations: demo.locations.map((location) => ({ id: location.id, name: location.name })),
  scenes: demo.scenes.map((scene) => ({
    id: scene.id,
    sceneNumber: scene.sceneNumber,
    ...(scene.title === undefined ? {} : { title: scene.title }),
  })),
  shootDays: demo.shootDays.map((day) => ({ id: day.id, date: day.date })),
  today: "2026-09-10",
};

const interpret = (text: string, overrides: Partial<InterpretationContext> = {}) =>
  interpretWithRules({ productionId: "PROD-DEMO", text, context: { ...context, ...overrides } });

const onFriday = { start: friday, end: friday };

describe("the three golden sentences", () => {
  it("Sarah cannot shoot Friday.", () => {
    expect(interpret("Sarah cannot shoot Friday.")).toEqual({
      kind: "RESOLVED",
      change: { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onFriday },
      confidence: 0.9,
    });
  });

  it("The warehouse is unavailable Friday.", () => {
    expect(interpret("The warehouse is unavailable Friday.")).toEqual({
      kind: "RESOLVED",
      change: {
        type: "LOCATION_UNAVAILABLE",
        locationId: locations.warehouse,
        unavailable: onFriday,
      },
      confidence: 0.9,
    });
  });

  it("Scene 18 now needs a red car.", () => {
    expect(interpret("Scene 18 now needs a red car.")).toEqual({
      kind: "RESOLVED",
      change: {
        type: "SCENE_REQUIREMENT_CHANGED",
        sceneId: scenes.s18,
        requirement: { type: "PROP", name: "red car" },
      },
      confidence: 0.9,
    });
  });
});

describe("close variants", () => {
  it.each([
    ["sarah can't make friday", cast.sarah],
    ["Nadia is unavailable on 2026-09-18", cast.sarah],
    ["Sarah is out on September 18", cast.sarah],
    ["John won't be able to shoot Friday.", cast.john],
  ])("%s resolves the right cast member on Friday", (text, castId) => {
    expect(interpret(text)).toMatchObject({
      kind: "RESOLVED",
      change: { type: "CAST_UNAVAILABLE", castId, unavailable: onFriday },
    });
  });

  it.each([
    ["Warehouse is closed Monday", monday],
    ["The Cafe is not available tomorrow", "2026-09-11"],
    ["Apartment unavailable today", "2026-09-10"],
  ])("%s resolves a location and the date", (text, date) => {
    expect(interpret(text)).toMatchObject({
      kind: "RESOLVED",
      change: { type: "LOCATION_UNAVAILABLE", unavailable: { start: date, end: date } },
    });
  });

  it.each([
    ["Scene 7 requires a crowbar", scenes.s07, "PROP", "crowbar"],
    ["Add a raincoat to scene 22", scenes.s22, "WARDROBE", "raincoat"],
    ["scene 18 needs a drone", scenes.s18, "EQUIPMENT", "drone"],
  ])("%s resolves scene, type, and name", (text, sceneId, type, name) => {
    expect(interpret(text)).toMatchObject({
      kind: "RESOLVED",
      change: { type: "SCENE_REQUIREMENT_CHANGED", sceneId, requirement: { type, name } },
    });
  });
});

describe("ambiguity is returned, not guessed", () => {
  it("offers both people when two cast members share a name", () => {
    const result = interpret("Sarah cannot shoot Friday.", {
      castMembers: [...context.castMembers, { id: "CAST-SARAH-2", name: "Sarah" }],
    });
    expect(result.kind).toBe("AMBIGUOUS");
    if (result.kind !== "AMBIGUOUS") return;
    expect(result.options.map((option) => (option.change as { castId: string }).castId)).toEqual([
      cast.sarah,
      "CAST-SARAH-2",
    ]);
  });

  it("offers each shoot day when a weekday matches more than one", () => {
    const result = interpret("Sarah cannot shoot Friday.", {
      shootDays: [...context.shootDays, { id: "SD-2026-09-25", date: "2026-09-25" }],
    });
    expect(result.kind).toBe("AMBIGUOUS");
    if (result.kind !== "AMBIGUOUS") return;
    expect(result.options.map((option) => option.label)).toEqual([
      "Sarah, friday 2026-09-18",
      "Sarah, friday 2026-09-25",
    ]);
  });

  it("offers a person and a place when the sentence could mean either", () => {
    const result = interpret("Mike is unavailable Friday.", {
      locations: [...context.locations, { id: "LOC-MIKES", name: "Mike" }],
    });
    expect(result.kind).toBe("AMBIGUOUS");
  });
});

describe("date ranges (TASK-908: code review #9)", () => {
  const fridayToTuesday = { start: friday, end: tuesday };

  it.each([
    ["Sarah cannot shoot 2026-09-18 to 2026-09-22", cast.sarah, fridayToTuesday],
    ["Sarah is out September 18 through September 22.", cast.sarah, fridayToTuesday],
    ["John is unavailable September 18–22", cast.john, fridayToTuesday],
    ["Sarah cannot shoot Friday through Monday.", cast.sarah, { start: friday, end: monday }],
    ["Sarah cannot shoot Friday until Tuesday.", cast.sarah, fridayToTuesday],
  ])("%s keeps the whole range, not just its first day", (text, castId, unavailable) => {
    expect(interpret(text)).toMatchObject({
      kind: "RESOLVED",
      change: { type: "CAST_UNAVAILABLE", castId, unavailable },
    });
  });

  it("resolves a location range too", () => {
    expect(interpret("The warehouse is closed 2026-09-18 - 2026-09-21")).toMatchObject({
      kind: "RESOLVED",
      change: {
        type: "LOCATION_UNAVAILABLE",
        locationId: locations.warehouse,
        unavailable: { start: friday, end: monday },
      },
    });
  });

  it.each([
    ["Sarah cannot shoot 2026-09-22 to 2026-09-18", "ends (2026-09-18) before it starts"],
    ["Sarah cannot shoot 2026-13-45", "2026-13-45 is not a real date"],
    ["Sarah cannot shoot 2026-09-18 to 2026-09-31", "2026-09-31 is not a real date"],
    ["Sarah cannot shoot Friday through Wednesday", "No shoot day falls on a wednesday after"],
  ])("%s is refused with the reason, never truncated", (text, reason) => {
    const result = interpret(text);
    expect(result.kind).toBe("UNSUPPORTED");
    if (result.kind !== "UNSUPPORTED") return;
    expect(result.reason).toContain(reason);
  });

  it("asks for dates when the first weekday of a range matches several shoot days", () => {
    const result = interpret("Sarah cannot shoot Friday through Monday", {
      shootDays: [...context.shootDays, { id: "SD-2026-09-25", date: "2026-09-25" }],
    });
    expect(result).toMatchObject({ kind: "UNSUPPORTED" });
    if (result.kind !== "UNSUPPORTED") return;
    expect(result.reason).toContain("More than one shoot day falls on a friday");
  });
});

describe("positive availability is refused, never inverted (TASK-908: code review #9)", () => {
  it.each([
    "Sarah is available Friday.",
    "Sarah is available again on Friday",
    "The warehouse is available Friday.",
    "John and Sarah are available Friday",
    "Sarah can shoot Friday.",
    "Sarah is free Friday",
  ])("%s", (text) => {
    const result = interpret(text);
    expect(result.kind).toBe("UNSUPPORTED");
    if (result.kind !== "UNSUPPORTED") return;
    expect(result.reason).toContain("is available");
    expect(result.reason).toContain("Only unavailability can be recorded");
  });

  it.each([
    ["Sarah is not available Friday", cast.sarah],
    ["Sarah isn't available Friday", cast.sarah],
    ["John and Sarah aren't available Friday", cast.john],
  ])("%s still resolves as unavailability", (text, castId) => {
    const result = interpret(text);
    // Two people → ambiguity; one → resolved. Either way, the negative reading held.
    if (result.kind === "AMBIGUOUS") {
      expect(result.options.every((o) => o.change.type === "CAST_UNAVAILABLE")).toBe(true);
      return;
    }
    expect(result).toMatchObject({
      kind: "RESOLVED",
      change: { type: "CAST_UNAVAILABLE", castId },
    });
  });
});

describe("unsupported is honest", () => {
  it.each([
    ["Please reschedule everything.", "Availability sentences"],
    ["Zoe cannot shoot Friday.", "No cast member or location"],
    ["Sarah cannot shoot Wednesday.", "No shoot day falls on a wednesday"],
    ["Sarah cannot shoot.", "No date"],
    ["Scene 99 now needs a red car.", "No scene numbered 99"],
    ["Scene 18 is great.", "Scene sentences"],
  ])("%s", (text, reason) => {
    const result = interpret(text);
    expect(result.kind).toBe("UNSUPPORTED");
    if (result.kind !== "UNSUPPORTED") return;
    expect(result.reason).toContain(reason);
  });
});

describe("explain and rank are deterministic and data-bound", () => {
  const change = { type: "CAST_UNAVAILABLE", castId: cast.sarah, unavailable: onFriday } as const;

  it("assembles prose from the findings", () => {
    const { explanation } = explainWithRules({
      productionId: "PROD-DEMO",
      rawText: "Sarah cannot shoot Friday.",
      change,
      impacts: [
        {
          entityType: "SCENE",
          entityId: scenes.s07,
          reasonCode: "SCENE_REQUIRES_UNAVAILABLE_CAST",
          explanation: "Scene 07 needs Sarah on Friday.",
          severity: "BLOCKING",
        },
        {
          entityType: "CALL_SHEET",
          entityId: "CS-1",
          reasonCode: "CALL_SHEET_DERIVED_FROM_AFFECTED_SHOOT_DAY",
          explanation: "Call sheet must be regenerated.",
          severity: "WARNING",
        },
      ],
      conflicts: [],
      resolvedConflicts: [
        {
          code: "CAST_UNAVAILABLE_ON_SHOOT_DAY",
          entityType: "SCENE",
          entityId: scenes.s07,
          detail: "d",
        },
      ],
    });
    expect(explanation).toBe(
      "1 blocking conflict: Scene 07 needs Sarah on Friday. 1 item needs attention: Call sheet must be regenerated. Applying this resolves 1 existing conflict.",
    );
  });

  it("ranks fewest warnings first, then earliest, citing the data", () => {
    const { ranked } = rankWithRules({
      productionId: "PROD-DEMO",
      change,
      candidates: [
        {
          shootDayId: shootDays.monday,
          date: monday,
          sceneIds: [scenes.s07],
          warnings: ["John is already required on 2026-09-21 for Scene 22."],
        },
        { shootDayId: shootDays.tuesday, date: tuesday, sceneIds: [scenes.s07], warnings: [] },
      ],
    });
    expect(ranked).toEqual([
      { shootDayId: shootDays.tuesday, rank: 1, reason: "2026-09-22 has no warnings." },
      {
        shootDayId: shootDays.monday,
        rank: 2,
        reason: "2026-09-21 has 1 warning: John is already required on 2026-09-21 for Scene 22.",
      },
    ]);
  });
});

describe("behind the guard", () => {
  it("passes the guard for every golden sentence, with no network", async () => {
    const port = guardModelPort(createRuleModelAdapter(), { timeoutMs: 100 });
    for (const text of [
      "Sarah cannot shoot Friday.",
      "The warehouse is unavailable Friday.",
      "Scene 18 now needs a red car.",
    ]) {
      const input: InterpretChangeInput = { productionId: "PROD-DEMO", text, context };
      expect((await port.interpretChange(input)).kind, text).toBe("RESOLVED");
    }
  });
});
