import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { ImpactExplanation } from "@pca/contracts";

import { ImpactPanel } from "./impact-panel";

const render = (explanation: ImpactExplanation | null) => {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ImpactPanel);
  fixture.componentRef.setInput("explanation", explanation);
  fixture.detectChanges();
  return fixture;
};

describe("ImpactPanel", () => {
  it("says nothing has been analyzed yet when there is no explanation", () => {
    const fixture = render(null);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      "Once a change is detected",
    );
  });

  it("GOLDEN-1: renders BLOCKING, AFFECTED grouped by kind (empty groups omitted), and WHY", () => {
    const fixture = render({
      blocking: ["2 scheduled scenes conflict with Sarah's availability."],
      affected: {
        scenes: ["07", "12"],
        shootDays: ["Fri Sep 18"],
        callSheets: ["Call sheet Fri Sep 18"],
        tasks: [],
        castMembers: [],
        locations: [],
      },
      why: [
        "Scene 07 requires Sarah and is scheduled Fri Sep 18.",
        "Scene 12 requires Sarah and is scheduled Fri Sep 18.",
      ],
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-group="blocking"]')?.textContent).toContain(
      "2 scheduled scenes conflict with Sarah's availability.",
    );

    const affected = root.querySelector('[data-group="affected"]');
    const terms = [...(affected?.querySelectorAll("dt") ?? [])].map((el) => el.textContent);
    expect(terms).toEqual(["Scenes", "Shoot days", "Call sheets"]);
    const values = [...(affected?.querySelectorAll("dd") ?? [])].map((el) => el.textContent);
    expect(values).toEqual(["07, 12", "Fri Sep 18", "Call sheet Fri Sep 18"]);

    const why = [...(root.querySelector('[data-group="why"]')?.querySelectorAll("li") ?? [])].map(
      (el) => el.textContent,
    );
    expect(why).toEqual([
      "Scene 07 requires Sarah and is scheduled Fri Sep 18.",
      "Scene 12 requires Sarah and is scheduled Fri Sep 18.",
    ]);
  });

  it("omits the BLOCKING section entirely when nothing blocks", () => {
    const fixture = render({
      blocking: [],
      affected: {
        scenes: ["18"],
        shootDays: [],
        callSheets: [],
        tasks: [],
        castMembers: [],
        locations: [],
      },
      why: ["Scene 18 gains the prop requirement."],
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-group="blocking"]'),
    ).toBeNull();
  });

  it("shows a plain message when nothing is affected", () => {
    const fixture = render({
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
    });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("Nothing affected.");
  });
});
