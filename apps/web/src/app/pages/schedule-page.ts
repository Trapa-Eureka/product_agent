import { ChangeDetectionStrategy, Component, effect, inject, signal } from "@angular/core";

import type { EntityId } from "@pca/contracts";

import { ProductionApi } from "../api/production-api";
import { ProductionStore } from "../state/production.store";
import { buildScheduleRows, type NormalizedScene, type ScheduleDayRow } from "./schedule-format";

/**
 * DESIGN.md §2 Schedule nav entry (TASK-507). Fetches the current schedule,
 * resolves every scene it names (`get_schedule` only carries scene IDs),
 * and renders one section per shoot day, earliest first, through
 * `buildScheduleRows` — no layout logic of its own.
 */
@Component({
  selector: "pca-schedule-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Schedule</h1>
    @if (rows(); as rows) {
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
  `,
})
export class SchedulePage {
  private readonly api = inject(ProductionApi);
  private readonly store = inject(ProductionStore);
  readonly rows = signal<ScheduleDayRow[] | null>(null);

  constructor() {
    effect(() => {
      const productionId = this.store.productionId();
      if (productionId === null) return;
      void this.load(productionId);
    });
  }

  private async load(productionId: string): Promise<void> {
    this.rows.set(null);
    const schedule = await this.api.getSchedule(productionId);
    const sceneIds = [...new Set(schedule.shootDays.flatMap((day) => day.sceneIds))];
    const scenes = await Promise.all(
      sceneIds.map((sceneId) => this.api.getScene(productionId, sceneId)),
    );
    const byId = new Map<EntityId, NormalizedScene>(scenes.map((scene) => [scene.scene.id, scene]));
    this.rows.set(buildScheduleRows(schedule.shootDays, byId));
  }
}
