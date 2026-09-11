import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";

import type { EntityId } from "@pca/contracts";

import { ProductionApi, toToolError } from "../api/production-api";
import { ProductionStore } from "../state/production.store";
import { LOADING, type PageLoad, latestOnly } from "./page-load";
import { buildScheduleRows, type NormalizedScene, type ScheduleDayRow } from "./schedule-format";

/**
 * DESIGN.md §2 Schedule nav entry (TASK-507). Fetches the current schedule
 * with its scenes resolved in the same read (`includeScenes`, TASK-913: one
 * request, not one per scene) and renders one section per shoot day,
 * earliest first, through `buildScheduleRows` — no layout logic of its own.
 *
 * The request is guarded (code review #15): only the newest one may write,
 * so switching productions while a slow answer is in flight cannot show the
 * old production's days under the new header; and a failure is shown as the
 * server's `ToolError` with a retry, never left as an endless "Loading…".
 */
@Component({
  selector: "pca-schedule-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Schedule</h1>
    @if (state().kind === "error") {
      <p class="error" role="alert">
        <strong>{{ error()?.code }}</strong> {{ error()?.message }}
        @if (error()?.nextStep; as next) {
          <span class="next">{{ next }}</span>
        }
        <button type="button" (click)="reload()">Retry</button>
      </p>
    } @else if (rows(); as rows) {
      @if (rows.length === 0) {
        <p class="pending">No shoot days yet.</p>
      } @else {
        @for (day of rows; track day.shootDayId) {
          <section class="day">
            <h2>
              {{ day.date }} <span class="status">{{ day.status }}</span>
            </h2>
            @if (day.scenes.length === 0) {
              <p class="pending">No scenes scheduled.</p>
            } @else {
              <ul>
                @for (scene of day.scenes; track scene.sceneId) {
                  <li>
                    <span class="label">{{ scene.label }}</span>
                    @if (scene.locationName; as locationName) {
                      <span class="meta">{{ locationName }}</span>
                    }
                    @if (scene.castNames.length > 0) {
                      <span class="meta">{{ scene.castNames.join(", ") }}</span>
                    }
                  </li>
                }
              </ul>
            }
          </section>
        }
      }
    } @else {
      <p role="status">Loading…</p>
    }
  `,
  styles: `
    h1 {
      font-size: 18px;
      margin: 0 0 12px;
    }
    .day {
      margin-bottom: 16px;
    }
    h2 {
      font-size: 14px;
      margin: 0 0 6px;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .status {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      font-weight: 400;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 10px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
    }
    .label {
      font-weight: 600;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .pending {
      color: var(--muted);
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
export class SchedulePage {
  private readonly api = inject(ProductionApi);
  private readonly store = inject(ProductionStore);
  private readonly begin = latestOnly();
  readonly state = signal<PageLoad<ScheduleDayRow[]>>(LOADING);
  readonly rows = computed(() => {
    const state = this.state();
    return state.kind === "ready" ? state.value : null;
  });
  readonly error = computed(() => {
    const state = this.state();
    return state.kind === "error" ? state.error : null;
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
      const schedule = await this.api.getSchedule(productionId, { includeScenes: true });
      if (!isCurrent()) return;
      const byId = new Map<EntityId, NormalizedScene>(
        (schedule.scenes ?? []).map((scene) => [scene.scene.id, scene]),
      );
      this.state.set({ kind: "ready", value: buildScheduleRows(schedule.shootDays, byId) });
    } catch (error) {
      if (!isCurrent()) return;
      this.state.set({ kind: "error", error: toToolError(error) });
    }
  }
}
