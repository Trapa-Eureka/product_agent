import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import type { CandidateComparison } from "@pca/contracts";

/**
 * DESIGN.md §2 "Proposed Plan" candidate comparison (TASK-504): the shoot
 * days the candidate generator considered for a scheduling change, ranked
 * with the model's reason each, and the ones it rejected with why. Shown
 * only for a scheduling change — `ChangeWorkspace` omits this component
 * entirely when the tracked job carries no `candidateComparison`.
 */
@Component({
  selector: "pca-candidate-comparison",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="comparison">
      <h3>Candidates considered</h3>
      <ol>
        @for (candidate of comparison().ranked; track candidate.shootDayId) {
          <li [class.chosen]="candidate.rank === 1">
            <div class="row">
              <span class="rank">#{{ candidate.rank }}</span>
              <span class="date">{{ candidate.date }}</span>
            </div>
            <p class="reason">{{ candidate.reason }}</p>
            @if (candidate.warnings.length > 0) {
              <ul class="warnings">
                @for (warning of candidate.warnings; track warning) {
                  <li>{{ warning }}</li>
                }
              </ul>
            }
          </li>
        }
      </ol>
      @if (comparison().rejected.length > 0) {
        <h3>Not considered</h3>
        <ul class="rejected">
          @for (day of comparison().rejected; track day.shootDayId) {
            <li>
              <span class="date">{{ day.date }}</span>
              <ul>
                @for (reason of day.reasons; track reason) {
                  <li>{{ reason }}</li>
                }
              </ul>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 10px 0 4px;
    }
    h3:first-child {
      margin-top: 0;
    }
    ol,
    ul.rejected {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    ol > li {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 8px;
    }
    ol > li.chosen {
      border-color: var(--ok);
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: baseline;
    }
    .rank {
      font-weight: 700;
    }
    .date {
      color: var(--muted);
    }
    .reason {
      margin: 2px 0 0;
    }
    .warnings {
      list-style: none;
      margin: 4px 0 0;
      padding: 0;
      color: var(--warn);
      font-size: 12px;
    }
    ul.rejected > li {
      color: var(--muted);
      font-size: 12px;
    }
    ul.rejected ul {
      list-style: none;
      margin: 0;
      padding-left: 8px;
    }
  `,
})
export class CandidateComparisonPanel {
  readonly comparison = input.required<CandidateComparison>();
}
