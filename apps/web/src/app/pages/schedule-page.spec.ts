import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { McpToolOutput } from "@pca/contracts";

import { ApiError, ProductionApi } from "../api/production-api";
import { ProductionStore } from "../state/production.store";
import { SchedulePage } from "./schedule-page";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Schedule = McpToolOutput<"get_schedule">;

const normalizedScene = (sceneId: string, productionId = "PROD-DEMO") => ({
  scene: {
    id: sceneId,
    productionId,
    sceneNumber: sceneId === "SCENE-07" ? "07" : "22",
    title: sceneId === "SCENE-07" ? "Standoff at the loading dock" : "Emil packs in the rain",
    locationId: "LOC-1",
    requiredCastIds: [],
    requirementIds: [],
    estimatedMinutes: 60,
  },
  location: { id: "LOC-1", productionId, name: "Warehouse", unavailable: [] },
  requiredCast: [],
  requirements: [],
  scheduledShootDayId: null,
});

const twoDays: Schedule = {
  productionVersion: 3,
  shootDays: [
    {
      id: "SD-MON",
      productionId: "PROD-DEMO",
      date: "2026-09-21",
      sceneIds: ["SCENE-22"],
      status: "CONFIRMED",
    },
    {
      id: "SD-FRI",
      productionId: "PROD-DEMO",
      date: "2026-09-18",
      sceneIds: ["SCENE-07"],
      status: "CONFIRMED",
    },
  ],
  scenes: [normalizedScene("SCENE-22"), normalizedScene("SCENE-07")],
};

/** get_scene must never be called: the schedule carries its scenes (TASK-913). */
const getScene = () => Promise.reject(new Error("get_scene must not be called"));

const mount = (api: object, productionId = signal<string | null>("PROD-DEMO")) => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ProductionApi, useValue: { getScene, ...api } },
      { provide: ProductionStore, useValue: { productionId } },
    ],
  });
  const fixture = TestBed.createComponent(SchedulePage);
  fixture.detectChanges();
  return fixture;
};

describe("SchedulePage", () => {
  it("renders the scenes the schedule carries, one section per day, earliest first, in one request", async () => {
    const calls: unknown[][] = [];
    const getSchedule = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(twoDays);
    };
    const fixture = mount({ getSchedule });
    await settle();
    fixture.detectChanges();

    expect(calls).toEqual([["PROD-DEMO", { includeScenes: true }]]);

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
        scenes: [],
      });
    const fixture = mount({ getSchedule });
    await settle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("No scenes scheduled.");
  });

  it("TASK-913: shows the server's error with a retry instead of loading forever, and retries", async () => {
    let attempts = 0;
    const getSchedule = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(
            new ApiError(503, {
              code: "INTERNAL_ERROR",
              message: "store unavailable",
              nextStep: "Try again shortly.",
            }),
          )
        : Promise.resolve(twoDays);
    };
    const fixture = mount({ getSchedule });
    await settle();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const alert = element.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("INTERNAL_ERROR");
    expect(alert?.textContent).toContain("store unavailable");
    expect(alert?.textContent).toContain("Try again shortly.");
    expect(element.textContent).not.toContain("Loading…");

    (element.querySelector("button") as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(element.textContent).toContain("Loading…");
    await settle();
    fixture.detectChanges();
    expect(attempts).toBe(2);
    expect(element.querySelectorAll(".day")).toHaveLength(2);
    expect(element.querySelector("[role=alert]")).toBeNull();
  });

  it("TASK-913: ignores a slow answer about the production the page has since left", async () => {
    const pending = new Map<string, (schedule: Schedule) => void>();
    const getSchedule = (productionId: string) =>
      new Promise<Schedule>((resolve) => pending.set(productionId, resolve));
    const productionId = signal<string | null>("PROD-OLD");
    const fixture = mount({ getSchedule }, productionId);

    productionId.set("PROD-DEMO");
    fixture.detectChanges();
    await settle();
    // The new production answers first, then the old one straggles in.
    pending.get("PROD-DEMO")?.(twoDays);
    await settle();
    pending.get("PROD-OLD")?.({
      productionVersion: 9,
      shootDays: [
        {
          id: "SD-OLD",
          productionId: "PROD-OLD",
          date: "2026-01-01",
          sceneIds: [],
          status: "DRAFT",
        },
      ],
      scenes: [],
    });
    await settle();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll(".day")).toHaveLength(2);
    expect(element.textContent).not.toContain("Jan 1, 2026");
  });
});
