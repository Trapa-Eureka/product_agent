import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { AuditEvent } from "@pca/contracts";

import { ApiError, ProductionApi } from "../api/production-api";
import { ProductionStore } from "../state/production.store";
import { AuditPage } from "./audit-page";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const events: AuditEvent[] = [
  {
    id: "AE-2",
    productionId: "PROD-DEMO",
    actorType: "USER",
    actorId: "jinho@example.test",
    action: "PROPOSAL_APPROVED",
    entityId: "P-104",
    createdAt: "2026-09-10T05:05:00.000Z",
  },
  {
    id: "AE-1",
    productionId: "PROD-DEMO",
    actorType: "USER",
    actorId: "coordinator@example.test",
    action: "CHANGE_REQUEST_SUBMITTED",
    metadata: { rawText: "Sarah cannot shoot Friday." },
    createdAt: "2026-09-10T05:03:00.000Z",
  },
];

describe("AuditPage", () => {
  it("renders the story oldest first, though the API returns newest first", async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ProductionApi, useValue: { listAudit: () => Promise.resolve({ events }) } },
        {
          provide: ProductionStore,
          useValue: {
            productionId: signal("PROD-DEMO"),
            production: signal({
              id: "PROD-DEMO",
              name: "Demo Movie",
              timezone: "Asia/Manila",
              version: 1,
            }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AuditPage);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("13:03");
    expect(rows[0]?.textContent).toContain(
      'coordinator@example.test reported: "Sarah cannot shoot Friday."',
    );
    expect(rows[1]?.textContent).toContain("13:05");
    expect(rows[1]?.textContent).toContain("jinho@example.test approved P-104.");
  });

  it("TASK-913: shows the server's error with a retry, and ignores a stale answer", async () => {
    const pending = new Map<
      string,
      { resolve: (v: { events: AuditEvent[] }) => void; reject: (e: unknown) => void }
    >();
    const listAudit = (productionId: string) =>
      new Promise<{ events: AuditEvent[] }>((resolve, reject) =>
        pending.set(productionId, { resolve, reject }),
      );
    const productionId = signal<string | null>("PROD-OLD");
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ProductionApi, useValue: { listAudit } },
        { provide: ProductionStore, useValue: { productionId, production: signal(null) } },
      ],
    });
    const fixture = TestBed.createComponent(AuditPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    productionId.set("PROD-DEMO");
    fixture.detectChanges();
    await settle();
    pending
      .get("PROD-DEMO")
      ?.reject(new ApiError(500, { code: "INTERNAL_ERROR", message: "audit store down" }));
    await settle();
    fixture.detectChanges();
    expect(element.querySelector("[role=alert]")?.textContent).toContain("audit store down");

    // The old production's answer arrives late: it must not replace the error, nor render.
    pending.get("PROD-OLD")?.resolve({ events });
    await settle();
    fixture.detectChanges();
    expect(element.querySelectorAll("li")).toHaveLength(0);
    expect(element.querySelector("[role=alert]")).not.toBeNull();

    pending.delete("PROD-DEMO");
    (element.querySelector("button") as HTMLButtonElement).click();
    await settle();
    pending.get("PROD-DEMO")?.resolve({ events });
    await settle();
    fixture.detectChanges();
    expect(element.querySelectorAll("li")).toHaveLength(2);
    expect(element.querySelector("[role=alert]")).toBeNull();
  });

  it("shows a plain message with no events", async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ProductionApi, useValue: { listAudit: () => Promise.resolve({ events: [] }) } },
        {
          provide: ProductionStore,
          useValue: { productionId: signal("PROD-DEMO"), production: signal(null) },
        },
      ],
    });
    const fixture = TestBed.createComponent(AuditPage);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("No events yet.");
  });
});
