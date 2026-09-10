import { ChangeDetectionStrategy, Component, effect, inject, signal } from "@angular/core";

import type { AuditEvent } from "@pca/contracts";

import { ProductionApi } from "../api/production-api";
import { ProductionStore } from "../state/production.store";

/**
 * The audit trail, newest first (DESIGN.md §7). Enough for the shell to prove
 * the REST connection point end to end; TASK-508 adds filtering and detail.
 */
@Component({
  selector: "pca-audit-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Audit</h1>
    @if (events(); as list) {
      @if (list.length === 0) {
        <p class="pending">No events yet.</p>
      } @else {
        <ol class="events">
          @for (event of list; track event.id) {
            <li>
              <span class="when">{{ event.createdAt }}</span>
              <span class="who">{{ event.actorType }}</span>
              <span class="what">{{ event.action }}</span>
              <code>{{ event.entityType }} {{ event.entityId }}</code>
            </li>
          }
        </ol>
      }
    } @else {
      <p role="status">Loading…</p>
    }
  `,
  styles: `
    h1 {
      font-size: 18px;
      margin: 0 0 8px;
    }
    .pending {
      color: var(--muted);
    }
    .events {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    li {
      display: grid;
      grid-template-columns: max-content max-content max-content 1fr;
      gap: 12px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
    }
    .when,
    .who {
      color: var(--muted);
    }
    .what {
      font-weight: 600;
    }
  `,
})
export class AuditPage {
  private readonly api = inject(ProductionApi);
  private readonly store = inject(ProductionStore);
  readonly events = signal<AuditEvent[] | null>(null);

  constructor() {
    effect(() => {
      const productionId = this.store.productionId();
      if (productionId === null) return;
      void this.api.listAudit(productionId).then(({ events }) => this.events.set(events));
    });
  }
}
