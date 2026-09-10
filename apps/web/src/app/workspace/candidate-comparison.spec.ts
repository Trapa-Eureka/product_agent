import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { CandidateComparison } from "@pca/contracts";

import { CandidateComparisonPanel } from "./candidate-comparison";

const render = (comparison: CandidateComparison) => {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(CandidateComparisonPanel);
  fixture.componentRef.setInput("comparison", comparison);
  fixture.detectChanges();
  return fixture;
};

describe("CandidateComparisonPanel", () => {
  it("GOLDEN-1: ranks Tuesday over Monday, marking the top rank chosen, and lists Monday's warning", () => {
    const fixture = render({
      ranked: [
        {
          shootDayId: "SD-2026-09-22",
          date: "2026-09-22",
          sceneIds: ["S07", "S12"],
          warnings: [],
          rank: 1,
          reason: "2026-09-22 has no warnings.",
        },
        {
          shootDayId: "SD-2026-09-21",
          date: "2026-09-21",
          sceneIds: ["S07", "S12"],
          warnings: ["John is already required that day."],
          rank: 2,
          reason: "2026-09-21 has 1 warning: John is already required that day.",
        },
      ],
      rejected: [
        {
          shootDayId: "SD-2026-09-18",
          date: "2026-09-18",
          reasons: ["A moving scene is already scheduled on 2026-09-18."],
        },
      ],
    });
    const root = fixture.nativeElement as HTMLElement;
    const ranked = [...root.querySelectorAll("ol > li")];
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.classList.contains("chosen")).toBe(true);
    expect(ranked[0]?.textContent).toContain("#1");
    expect(ranked[0]?.textContent).toContain("2026-09-22");
    expect(ranked[1]?.classList.contains("chosen")).toBe(false);
    expect(ranked[1]?.textContent).toContain("John is already required that day.");

    const rejected = [...root.querySelectorAll("ul.rejected > li")];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.textContent).toContain("2026-09-18");
    expect(rejected[0]?.textContent).toContain(
      "A moving scene is already scheduled on 2026-09-18.",
    );
  });

  it("omits the Not considered section when nothing was rejected", () => {
    const fixture = render({
      ranked: [
        {
          shootDayId: "SD-2026-09-22",
          date: "2026-09-22",
          sceneIds: ["S07"],
          warnings: [],
          rank: 1,
          reason: "2026-09-22 has no warnings.",
        },
      ],
      rejected: [],
    });
    expect((fixture.nativeElement as HTMLElement).querySelector("ul.rejected")).toBeNull();
  });
});
