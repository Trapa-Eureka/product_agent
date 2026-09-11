import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { ProposalExplanation } from "@pca/contracts";

import { ProposalCard } from "./proposal-card";

const render = (explanation: ProposalExplanation) => {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ProposalCard);
  fixture.componentRef.setInput("explanation", explanation);
  fixture.detectChanges();
  return fixture;
};

describe("ProposalCard", () => {
  it("GOLDEN-1: renders the headline, + and ! effects with a mark each, and every operation", () => {
    const fixture = render({
      headline: "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
      effects: [
        { tone: "POSITIVE", text: "resolves Sarah conflict on Scene 07 and Scene 12" },
        { tone: "ATTENTION", text: "Call sheet Fri Sep 18 must be regenerated" },
      ],
      operations: [
        "record Sarah unavailable Fri Sep 18",
        "remove Scene 07 from Fri Sep 18",
        "mark Call sheet Fri Sep 18 for regeneration",
      ],
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector(".headline")?.textContent).toBe(
      "Move Scene 07 and Scene 12 from Fri Sep 18 → Tue Sep 22",
    );

    const effects = [...root.querySelectorAll('[data-group="effects"] li')];
    expect(effects).toHaveLength(2);
    expect(effects[0]?.getAttribute("data-tone")).toBe("POSITIVE");
    expect(effects[0]?.textContent).toContain("+");
    expect(effects[0]?.textContent).toContain("resolves Sarah conflict on Scene 07 and Scene 12");
    expect(effects[1]?.getAttribute("data-tone")).toBe("ATTENTION");
    expect(effects[1]?.textContent).toContain("!");

    const operations = [...root.querySelectorAll('[data-group="operations"] li')].map(
      (el) => el.textContent,
    );
    expect(operations).toEqual([
      "record Sarah unavailable Fri Sep 18",
      "remove Scene 07 from Fri Sep 18",
      "mark Call sheet Fri Sep 18 for regeneration",
    ]);
  });

  it("omits the Effects section when there are none", () => {
    const fixture = render({
      headline: "Record Mike unavailable Fri Sep 18",
      effects: [],
      operations: ["record Mike unavailable Fri Sep 18"],
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-group="effects"]'),
    ).toBeNull();
  });

  it("renders the model's narrative when present", () => {
    const fixture = render({
      headline: "Record Mike unavailable Fri Sep 18",
      effects: [],
      operations: ["record Mike unavailable Fri Sep 18"],
      narrative: "Mike has no scenes that day.",
    });
    expect((fixture.nativeElement as HTMLElement).querySelector(".narrative")?.textContent).toBe(
      "Mike has no scenes that day.",
    );
  });

  it("renders nothing for the narrative when the model did not answer", () => {
    const fixture = render({
      headline: "Record Mike unavailable Fri Sep 18",
      effects: [],
      operations: ["record Mike unavailable Fri Sep 18"],
    });
    expect((fixture.nativeElement as HTMLElement).querySelector(".narrative")).toBeNull();
  });

  const bare: ProposalExplanation = {
    headline: "Move Scene 07 from Fri Sep 18 → Tue Sep 22",
    effects: [{ tone: "ATTENTION", text: "Call sheet Fri Sep 18 must be regenerated" }],
    operations: ["remove Scene 07 from Fri Sep 18"],
  };

  it("TASK-920: shows no narrative section when the model wrote none", () => {
    const without = render(bare).nativeElement as HTMLElement;
    expect(without.querySelector('[data-group="narrative"]')).toBeNull();
  });

  it("TASK-920: renders the model narrative last, labelled as the model's", () => {
    const root = render({ ...bare, narrative: "Moving Scene 07 keeps Tuesday light." })
      .nativeElement as HTMLElement;
    const groups = [...root.querySelectorAll("section")].map((section) =>
      section.getAttribute("data-group"),
    );
    expect(groups).toEqual(["effects", "operations", "narrative"]);
    const narrative = root.querySelector('[data-group="narrative"]');
    expect(narrative?.querySelector("h3")?.textContent).toBe("Model narrative");
    expect(narrative?.querySelector(".narrative")?.textContent).toBe(
      "Moving Scene 07 keeps Tuesday light.",
    );
    expect(narrative?.querySelector(".caveat")?.textContent).toContain("this paragraph is not");
  });
});
