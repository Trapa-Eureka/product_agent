import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

import type { ImpactExplanation } from "@pca/contracts";

/** Group order matches `renderImpactExplanation` (`packages/application/src/explanation.ts`) exactly. */
const AFFECTED_GROUPS: readonly [string, keyof ImpactExplanation["affected"]][] = [
  ["Scenes", "scenes"],
  ["Shoot days", "shootDays"],
  ["Call sheets", "callSheets"],
  ["Tasks", "tasks"],
  ["Cast", "castMembers"],
  ["Locations", "locations"],
];

/**
 * DESIGN.md §3 impact panel: BLOCKING, AFFECTED grouped by kind, WHY.
 * Purely presentational — the grouping and every line of text come from
 * `describeImpact` on the server (TASK-306, TASK-503); this component only
 * lays them out. Empty groups are omitted, matching the server's own text
 * rendering.
 */
@Component({
  selector: "pca-impact-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (explanation(); as impact) {
      <div class="impact">
        @if (impact.blocking.length > 0) {
          <section data-group="blocking">
            <h3>Blocking</h3>
            <ul>
              @for (line of impact.blocking; track line) {
                <li>{{ line }}</li>
              }
            </ul>
          </section>
        }
        <section data-group="affected">
          <h3>Affected</h3>
          @if (affectedGroups().length === 0) {
            <p class="none">Nothing affected.</p>
          } @else {
            <dl>
              @for (group of affectedGroups(); track group.label) {
                <dt>{{ group.label }}</dt>
                <dd>{{ group.items.join(", ") }}</dd>
              }
            </dl>
          }
        </section>
        <section data-group="why">
          <h3>Why</h3>
          <ul>
            @for (line of impact.why; track line) {
              <li>{{ line }}</li>
            }
          </ul>
        </section>
      </div>
    } @else {
      <p class="pending">Once a change is detected, its impact appears here.</p>
    }
  `,
  styles: `
    h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 10px 0 4px;
    }
    section:first-child h3 {
      margin-top: 0;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li {
      margin: 2px 0;
    }
    [data-group="blocking"] li {
      color: var(--danger);
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 2px 10px;
      margin: 0;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
    }
    .pending,
    .none {
      color: var(--muted);
      margin: 0;
    }
  `,
})
export class ImpactPanel {
  readonly explanation = input.required<ImpactExplanation | null>();

  readonly affectedGroups = computed(() => {
    const impact = this.explanation();
    if (impact === null) return [];
    return AFFECTED_GROUPS.map(([label, key]) => ({ label, items: impact.affected[key] })).filter(
      (group) => group.items.length > 0,
    );
  });
}
