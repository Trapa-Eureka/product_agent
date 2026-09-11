import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";

import type { AuditEvent } from "@pca/contracts";

import { ProductionApi, toToolError } from "../api/production-api";
import { ProductionStore } from "../state/production.store";
import { describeAuditEvent, formatAuditTime } from "./audit-format";
import { LOADING, type PageLoad, latestOnly } from "./page-load";

/**
 * The audit trail (DESIGN.md §7, TASK-508): "make the agent trustworthy."
 * `listAudit` returns newest first (an operator asking "what just
 * happened" wants that), but this view's job is the story in the order it
 * happened, so it renders oldest first. Every line is a plain sentence
 * from `describeAuditEvent` — a deterministic fact, never the model's own
 * words or its reasoning — with a timestamp in the production's own
 * timezone, matching the header's version and the rest of the console.
 *
 * The read is guarded like the schedule's (TASK-913, code review #15): only
 * the newest request writes, and a failure shows the server's `ToolError`
 * with a retry rather than an endless "Loading…".
 */
@Component({
  selector: "pca-audit-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Audit</h1>
    @if (error(); as error) {
      <p class="error" role="alert">
        <strong>{{ error.code }}</strong> {{ error.message }}
        @if (error.nextStep; as next) {
          <span class="next">{{ next }}</span>
        }
        <button type="button" (click)="reload()">Retry</button>
      </p>
    } @else if (rows(); as rows) {
      @if (rows.length === 0) {
        <p class="pending">No events yet.</p>
      } @else {
        <ol class="events">
          @for (row of rows; track row.event.id) {
            <li>
              <span class="when">{{ row.time }}</span>
              <span class="what">{{ row.text }}</span>
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
      display: flex;
      gap: 12px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
    }
    .when {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .error {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;
      color: var(--danger);
    }
    .next {
      color: var(--muted);
    }
  `,
})
export class AuditPage {
  private readonly api = inject(ProductionApi);
  private readonly store = inject(ProductionStore);
  private readonly begin = latestOnly();
  readonly state = signal<PageLoad<AuditEvent[]>>(LOADING);

  readonly error = computed(() => {
    const state = this.state();
    return state.kind === "error" ? state.error : null;
  });

  readonly rows = computed(() => {
    const state = this.state();
    if (state.kind !== "ready") return null;
    const timeZone = this.store.production()?.timezone;
    return [...state.value].reverse().map((event) => ({
      event,
      time: formatAuditTime(event.createdAt, timeZone),
      text: describeAuditEvent(event),
    }));
  });

  constructor() {
    effect(() => {
      const productionId = this.store.productionId();
      if (productionId === null) return;
      void this.load(productionId);
    });
  }

  reload(): void {
    const productionId = this.store.productionId();
    if (productionId !== null) void this.load(productionId);
  }

  private async load(productionId: string): Promise<void> {
    const isCurrent = this.begin();
    this.state.set(LOADING);
    try {
      const { events } = await this.api.listAudit(productionId);
      if (!isCurrent()) return;
      this.state.set({ kind: "ready", value: events });
    } catch (error) {
      if (!isCurrent()) return;
      this.state.set({ kind: "error", error: toToolError(error) });
    }
  }
}
