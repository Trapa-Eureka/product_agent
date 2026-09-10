import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { ChangeRequest } from "@pca/contracts";

import { DetectedChangeCard } from "./detected-change-card";

const changeRequest: ChangeRequest = {
  id: "CR-1",
  productionId: "PROD-DEMO",
  type: "CAST_UNAVAILABLE",
  rawText: "Sarah cannot shoot Friday.",
  payload: {
    type: "CAST_UNAVAILABLE",
    castId: "CAST-SARAH",
    unavailable: { start: "2026-09-18", end: "2026-09-18" },
  },
  correlationId: "corr-1",
  createdBy: "coordinator@example.test",
  createdAt: "2026-09-10T12:00:00.000Z",
};

describe("DetectedChangeCard", () => {
  it("renders the normalized type, the original sentence, and the resolved fields", () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(DetectedChangeCard);
    fixture.componentRef.setInput("changeRequest", changeRequest);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Cast unavailable");
    expect(text).toContain("Sarah cannot shoot Friday.");
    expect(text).toContain("CAST-SARAH");
    expect(text).toContain("Fri, Sep 18, 2026");
  });

  it("GOLDEN-3: renders a requirement change with its scene and requirement", () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(DetectedChangeCard);
    fixture.componentRef.setInput("changeRequest", {
      ...changeRequest,
      type: "SCENE_REQUIREMENT_CHANGED",
      rawText: "Scene 18 now needs a red car.",
      payload: {
        type: "SCENE_REQUIREMENT_CHANGED",
        sceneId: "S18",
        requirement: { type: "PROP", name: "red car" },
      },
    });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Scene requirement changed");
    expect(text).toContain("S18");
    expect(text).toContain("red car");
  });
});
