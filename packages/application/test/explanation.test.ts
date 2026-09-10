import { describe, expect, it } from "vitest";

import type { ProposedOperation } from "@pca/contracts";
import { proposalExplanationSchema, impactExplanationSchema } from "@pca/contracts";
import { analyzeImpact, indexProduction, simulateProposal } from "@pca/domain";
import { DEMO_MOVIE_DATES, DEMO_MOVIE_IDS, createDemoMovie } from "@pca/fixtures";
import { onDay, withLocationUnavailable } from "@pca/test-support";

import {
  PROPOSAL_SUMMARY_MAX_LENGTH,
  describeImpact,
  describeProposal,
  formatShootDate,
  renderImpactExplanation,
  renderProposalExplanation,
  toProposalSummary,
} from "../src";

const { cast, callSheets, locations, scenes, shootDays } = DEMO_MOVIE_IDS;
const { friday, monday } = DEMO_MOVIE_DATES;

const golden1: ProposedOperation[] = [
  { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.sarah, unavailable: onDay(friday) },
  {
    type: "MOVE_SCENES",
    sceneIds: [scenes.s07, scenes.s12],
    fromShootDayId: shootDays.friday,
    toShootDayId: shootDays.tuesday,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.friday },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
];

const golden3: ProposedOperation[] = [
  { type: "ADD_SCENE_REQUIREMENT", sceneId: scenes.s18, requirementType: "PROP", name: "red car" },
  {
    type: "CREATE_PREPARATION_TASK",
    title: "Source a red car for Scene 18",
    relatedEntityType: "SCENE",
    relatedEntityId: scenes.s18,
  },
  { type: "MARK_CALL_SHEET_STALE", callSheetId: callSheets.tuesday },
];

const cardFor = (operations: ProposedOperation[], state = createDemoMovie()) =>
  describeProposal({
    state,
    operations,
    simulation: simulateProposal(indexProduction(state), operations),
  });

describe("formatShootDate", () => {
  it("names the weekday and month without shifting the calendar date", () => {
    expect(formatShootDate("2026-09-18")).toBe("Fri Sep 18");
    expect(formatShootDate("2026-01-01")).toBe("Thu Jan 1");
    expect(formatShootDate("2026-12-31")).toBe("Thu Dec 31");
  });

  it("returns an unparseable value unchanged", () => {
    expect(formatShootDate("not-a-date")).toBe("not-a-date");
  });
});

describe("describeProposal", () => {
  it("GOLDEN-1: headline, effects, and operations come from the data", () => {
    const card = cardFor(golden1);
    expect(proposalExplanationSchema.parse(card)).toEqual(card);
    expect(card.headline).toBe("Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22");
    expect(card.effects.map((effect) => `${effect.tone} ${effect.text}`)).toEqual([
      "POSITIVE resolves Sarah conflict on Scene 07 and Scene 12",
      "POSITIVE Warehouse is available Tue Sep 22",
      "POSITIVE Sarah is recorded unavailable Fri Sep 18",
      "ATTENTION Sarah is required Tue Sep 22",
      "ATTENTION John is required Tue Sep 22",
      "ATTENTION Call sheet Fri Sep 18 must be regenerated",
      "ATTENTION Call sheet Tue Sep 22 must be regenerated",
    ]);
    expect(card.operations).toEqual([
      "record Sarah unavailable Fri Sep 18",
      "remove Scene 07 from Fri Sep 18",
      "remove Scene 12 from Fri Sep 18",
      "add Scene 07 to Tue Sep 22",
      "add Scene 12 to Tue Sep 22",
      "mark Call sheet Fri Sep 18 for regeneration",
      "mark Call sheet Tue Sep 22 for regeneration",
    ]);
    expect(card.narrative).toBeUndefined();
  });

  it("names the person or place a resolved conflict is about, and where", () => {
    const card = cardFor(golden1);
    expect(card.effects[0]).toEqual({
      tone: "POSITIVE",
      text: "resolves Sarah conflict on Scene 07 and Scene 12",
      entityType: "CAST_MEMBER",
      entityId: cast.sarah,
    });
  });

  it("GOLDEN-3: a requirement change names the requirement and the task it creates", () => {
    const card = cardFor(golden3);
    expect(card.headline).toBe('Add prop "red car" to Scene 18');
    expect(card.effects.map((effect) => `${effect.tone} ${effect.text}`)).toEqual([
      'ATTENTION prop "red car" must be ready by Tue Sep 22',
      "ATTENTION new task: Source a red car for Scene 18",
      "ATTENTION Call sheet Tue Sep 22 must be regenerated",
    ]);
    expect(card.operations).toEqual([
      'add prop "red car" to Scene 18',
      'create task "Source a red car for Scene 18"',
      "mark Call sheet Tue Sep 22 for regeneration",
    ]);
  });

  it("a fact-only proposal is named by its fact", () => {
    const operations: ProposedOperation[] = [
      { type: "RECORD_CAST_UNAVAILABILITY", castId: cast.mike, unavailable: onDay(friday) },
    ];
    const card = cardFor(operations);
    expect(card.headline).toBe("Record Mike unavailable Fri Sep 18");
    expect(card.effects.map((effect) => effect.text)).toEqual([
      "Mike is recorded unavailable Fri Sep 18",
    ]);
    expect(card.operations).toEqual(["record Mike unavailable Fri Sep 18"]);
  });

  it("a multi-day range reads as a range", () => {
    const card = cardFor([
      {
        type: "RECORD_LOCATION_UNAVAILABILITY",
        locationId: locations.cafe,
        unavailable: { start: friday, end: monday },
      },
    ]);
    expect(card.headline).toBe("Record Cafe unavailable Fri Sep 18 to Mon Sep 21");
  });

  it("an invalid proposal shows the conflict that remains and the unavailable place", () => {
    const state = withLocationUnavailable(createDemoMovie(), locations.warehouse, onDay(monday));
    const operations: ProposedOperation[] = [
      {
        type: "RECORD_LOCATION_UNAVAILABILITY",
        locationId: locations.warehouse,
        unavailable: onDay(friday),
      },
      {
        type: "MOVE_SCENES",
        sceneIds: [scenes.s07, scenes.s12],
        fromShootDayId: shootDays.friday,
        toShootDayId: shootDays.monday,
      },
    ];
    const simulation = simulateProposal(indexProduction(state), operations);
    expect(simulation.valid).toBe(false);
    const card = describeProposal({ state, operations, simulation });
    const texts = card.effects.map((effect) => `${effect.tone} ${effect.text}`);
    expect(texts).toContain("ATTENTION Warehouse is unavailable Mon Sep 21");
    expect(texts.filter((text) => text.startsWith("ATTENTION conflict remains:"))).toHaveLength(2);
    // Leaving Friday resolves Friday's conflicts even though Monday now has its own.
    expect(texts[0]).toBe("POSITIVE resolves Warehouse conflict on Scene 07 and Scene 12");
  });

  it("falls back to raw IDs for references the snapshot does not know", () => {
    const card = describeProposal({
      state: createDemoMovie(),
      operations: [
        { type: "MOVE_SCENES", sceneIds: ["S99"], fromShootDayId: "SD-X", toShootDayId: "SD-Y" },
        { type: "MARK_CALL_SHEET_STALE", callSheetId: "CS-X" },
      ],
    });
    expect(card.headline).toBe("Move S99 from SD-X → SD-Y");
    expect(card.operations).toEqual([
      "remove S99 from SD-X",
      "add S99 to SD-Y",
      "mark Call sheet CS-X for regeneration",
    ]);
    expect(card.effects.map((effect) => effect.text)).toEqual([
      "Call sheet CS-X must be regenerated",
    ]);
  });

  it("without simulation findings the card still lists what the operations imply", () => {
    const card = describeProposal({ state: createDemoMovie(), operations: golden1 });
    expect(card.effects.map((effect) => effect.text)).toEqual([
      "Warehouse is available Tue Sep 22",
      "Sarah is recorded unavailable Fri Sep 18",
      "Sarah is required Tue Sep 22",
      "John is required Tue Sep 22",
      "Call sheet Fri Sep 18 must be regenerated",
      "Call sheet Tue Sep 22 must be regenerated",
    ]);
  });

  it("carries the model's narrative without letting it change an effect", () => {
    const state = createDemoMovie();
    const simulation = simulateProposal(indexProduction(state), golden1);
    const plain = describeProposal({ state, operations: golden1, simulation });
    const narrated = describeProposal({
      state,
      operations: golden1,
      simulation,
      narrative: "Moving both scenes to Tuesday keeps the Warehouse block together.",
    });
    expect(narrated.effects).toEqual(plain.effects);
    expect(narrated.operations).toEqual(plain.operations);
    expect(narrated.narrative).toBe(
      "Moving both scenes to Tuesday keeps the Warehouse block together.",
    );
  });

  it("is deterministic", () => {
    expect(cardFor(golden1)).toEqual(cardFor(golden1));
  });
});

describe("renderProposalExplanation", () => {
  it("renders the DESIGN.md §4 block", () => {
    const card = cardFor(golden1);
    expect(renderProposalExplanation(card, { label: "Proposal A" })).toBe(
      [
        "Proposal A",
        "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
        "",
        "Effects",
        "+ resolves Sarah conflict on Scene 07 and Scene 12",
        "+ Warehouse is available Tue Sep 22",
        "+ Sarah is recorded unavailable Fri Sep 18",
        "! Sarah is required Tue Sep 22",
        "! John is required Tue Sep 22",
        "! Call sheet Fri Sep 18 must be regenerated",
        "! Call sheet Tue Sep 22 must be regenerated",
        "",
        "Operations",
        "- record Sarah unavailable Fri Sep 18",
        "- remove Scene 07 from Fri Sep 18",
        "- remove Scene 12 from Fri Sep 18",
        "- add Scene 07 to Tue Sep 22",
        "- add Scene 12 to Tue Sep 22",
        "- mark Call sheet Fri Sep 18 for regeneration",
        "- mark Call sheet Tue Sep 22 for regeneration",
      ].join("\n"),
    );
  });

  it("puts the narrative after the operations and marks an empty effect list", () => {
    const text = renderProposalExplanation({
      headline: "Record Mike unavailable Fri Sep 18",
      effects: [],
      operations: ["record Mike unavailable Fri Sep 18"],
      narrative: "Mike has no scenes that day.",
    });
    expect(text).toBe(
      [
        "Record Mike unavailable Fri Sep 18",
        "",
        "Effects",
        "(none)",
        "",
        "Operations",
        "- record Mike unavailable Fri Sep 18",
        "",
        "Mike has no scenes that day.",
      ].join("\n"),
    );
  });
});

describe("toProposalSummary", () => {
  it("is the rendered card when it fits", () => {
    const card = cardFor(golden3);
    expect(toProposalSummary(card)).toBe(renderProposalExplanation(card));
  });

  it("clips to the summary limit with an ellipsis", () => {
    const card = describeProposal({
      state: createDemoMovie(),
      operations: golden3,
      narrative: "x".repeat(PROPOSAL_SUMMARY_MAX_LENGTH),
    });
    const summary = toProposalSummary(card);
    expect(summary).toHaveLength(PROPOSAL_SUMMARY_MAX_LENGTH);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("describeImpact", () => {
  it("GOLDEN-1: counts the blocking scenes, lists the affected entities by kind, and says why", () => {
    const state = createDemoMovie();
    const change = {
      type: "CAST_UNAVAILABLE",
      castId: cast.sarah,
      unavailable: onDay(friday),
    } as const;
    const analysis = analyzeImpact(indexProduction(state), change);
    const panel = describeImpact({
      state,
      impacts: analysis.impacts,
      conflicts: analysis.conflicts,
      change,
    });
    expect(impactExplanationSchema.parse(panel)).toEqual(panel);
    expect(panel.blocking).toEqual(["2 scheduled scenes conflict with Sarah's availability."]);
    expect(panel.affected.scenes).toEqual(["07", "12"]);
    expect(panel.affected.shootDays).toEqual(["Fri Sep 18"]);
    expect(panel.affected.callSheets).toEqual(["Call sheet Fri Sep 18"]);
    expect(panel.affected.tasks).toEqual([
      "Confirm crew call for Friday",
      "Distribute Friday call sheet",
      "Prep crowbar for Scene 07",
    ]);
    expect(panel.why[0]).toContain("Scene 07");
    expect(panel.why).toEqual([...new Set(panel.why)]);
  });

  it("without a subject the blocking line still counts", () => {
    const state = createDemoMovie();
    const change = {
      type: "LOCATION_UNAVAILABLE",
      locationId: locations.warehouse,
      unavailable: onDay(friday),
    } as const;
    const analysis = analyzeImpact(indexProduction(state), change);
    const panel = describeImpact({
      state,
      impacts: analysis.impacts,
      conflicts: analysis.conflicts,
    });
    expect(panel.blocking).toEqual(["2 scheduled scenes conflict with location availability."]);
  });

  it("renders the DESIGN.md §3 panel, omitting empty groups", () => {
    const text = renderImpactExplanation({
      blocking: ["2 scheduled scenes conflict with Sarah's availability."],
      affected: {
        scenes: ["07", "12"],
        shootDays: ["Fri Sep 18"],
        callSheets: ["Call sheet Fri Sep 18"],
        tasks: [],
        castMembers: [],
        locations: [],
      },
      why: ["Scene 07 requires Sarah and is scheduled Fri Sep 18."],
    });
    expect(text).toBe(
      [
        "BLOCKING",
        "2 scheduled scenes conflict with Sarah's availability.",
        "",
        "AFFECTED",
        "Scenes: 07, 12",
        "Shoot days: Fri Sep 18",
        "Call sheets: Call sheet Fri Sep 18",
        "",
        "WHY",
        "Scene 07 requires Sarah and is scheduled Fri Sep 18.",
      ].join("\n"),
    );
  });

  it("an analysis with nothing to report renders its empty markers", () => {
    expect(
      renderImpactExplanation({
        blocking: [],
        affected: {
          scenes: [],
          shootDays: [],
          callSheets: [],
          tasks: [],
          castMembers: [],
          locations: [],
        },
        why: [],
      }),
    ).toBe(["AFFECTED", "(none)", "", "WHY", "(none)"].join("\n"));
  });
});
