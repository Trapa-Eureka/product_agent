import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { AuditEvent } from "@pca/contracts";

import { ProductionApi } from "../api/production-api";
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
