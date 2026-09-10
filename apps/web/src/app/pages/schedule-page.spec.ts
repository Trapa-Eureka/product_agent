import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { ProductionApi } from "../api/production-api";
import { ProductionStore } from "../state/production.store";
import { SchedulePage } from "./schedule-page";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SchedulePage", () => {
  it("resolves every scene a shoot day names and renders one section per day, earliest first", async () => {
    const getSchedule = () =>
      Promise.resolve({
        productionVersion: 3,
        shootDays: [
          {
            id: "SD-MON",
            productionId: "PROD-DEMO",
            date: "2026-09-21",
            sceneIds: ["SCENE-22"],
            status: "CONFIRMED" as const,
          },
          {
            id: "SD-FRI",
            productionId: "PROD-DEMO",
            date: "2026-09-18",
            sceneIds: ["SCENE-07"],
            status: "CONFIRMED" as const,
          },
        ],
      });
    const getScene = (_productionId: string, sceneId: string) =>
      Promise.resolve({
        scene: {
          id: sceneId,
          productionId: "PROD-DEMO",
          sceneNumber: sceneId === "SCENE-07" ? "07" : "22",
          title: sceneId === "SCENE-07" ? "Standoff at the loading dock" : "Emil packs in the rain",
          locationId: "LOC-1",
          requiredCastIds: [],
          requirementIds: [],
          estimatedMinutes: 60,
        },
        location: { id: "LOC-1", productionId: "PROD-DEMO", name: "Warehouse", unavailable: [] },
        requiredCast: [],
        requirements: [],
        scheduledShootDayId: null,
      });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ProductionApi, useValue: { getSchedule, getScene } },
        { provide: ProductionStore, useValue: { productionId: signal("PROD-DEMO") } },
      ],
    });
    const fixture = TestBed.createComponent(SchedulePage);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    const days = [...(fixture.nativeElement as HTMLElement).querySelectorAll(".day")];
    expect(days).toHaveLength(2);
    expect(days[0]?.textContent).toContain("Fri, Sep 18, 2026");
    expect(days[0]?.textContent).toContain("Scene 07 — Standoff at the loading dock");
    expect(days[0]?.textContent).toContain("Warehouse");
    expect(days[1]?.textContent).toContain("Mon, Sep 21, 2026");
    expect(days[1]?.textContent).toContain("Scene 22 — Emil packs in the rain");
  });

  it("shows a plain message for a shoot day with no scenes", async () => {
    const getSchedule = () =>
      Promise.resolve({
        productionVersion: 1,
        shootDays: [
          {
            id: "SD-1",
            productionId: "PROD-DEMO",
            date: "2026-09-18",
            sceneIds: [],
            status: "DRAFT" as const,
          },
        ],
      });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ProductionApi,
          useValue: {
            getSchedule,
            getScene: () => Promise.reject(new Error("must not be called for an empty day")),
          },
        },
        { provide: ProductionStore, useValue: { productionId: signal("PROD-DEMO") } },
      ],
    });
    const fixture = TestBed.createComponent(SchedulePage);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("No scenes scheduled.");
  });
});
