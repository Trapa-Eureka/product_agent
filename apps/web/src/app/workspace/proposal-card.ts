import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import type { ProposalExplanation } from "@pca/contracts";

/**
 * DESIGN.md §4 proposal comparison card: headline, `+`/`!` effects,
 * operations, one concrete step per line. Purely presentational — every
 * line of text is `describeProposal`'s, carried here on the tracked job's
 * `explanation` field (TASK-504); this component only lays it out.
 */
@Component({
  selector: "pca-proposal-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <p class="headline">{{ explanation().headline }}</p>
      @if (explanation().effects.length > 0) {
        <section data-group="effects">
          <h3>Effects</h3>
          <ul>
            @for (effect of explanation().effects; track effect.text) {
              <li [attr.data-tone]="effect.tone">
                <span class="mark">{{ effect.tone === "POSITIVE" ? "+" : "!" }}</span>
                {{ effect.text }}
              </li>
            }
          </ul>
        </section>
      }
      <section data-group="operations">
        <h3>Operations</h3>
        <ul>
          @for (operation of explanation().operations; track operation) {
            <li>{{ operation }}</li>
          }
        </ul>
      </section>
      @if (explanation().narrative; as narrative) {
        <p class="narrative">{{ narrative }}</p>
      }
    </div>
  `,
  styles: `
    .headline {
      font-weight: 600;
      margin: 0 0 8px;
    }
    h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 10px 0 4px;
    }
    section:first-of-type h3 {
      margin-top: 0;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    [data-group="operations"] li {
      padding-left: 14px;
      position: relative;
    }
    [data-group="operations"] li::before {
      content: "-";
      position: absolute;
      left: 0;
      color: var(--muted);
    }
    [data-group="effects"] li {
      margin: 2px 0;
    }
    [data-group="effects"] li[data-tone="POSITIVE"] .mark {
      color: var(--ok);
    }
    [data-group="effects"] li[data-tone="ATTENTION"] .mark {
      color: var(--warn);
    }
    .mark {
      font-weight: 700;
      display: inline-block;
      width: 1.2em;
    }
    .narrative {
      color: var(--muted);
      margin: 10px 0 0;
    }
  `,
})
export class ProposalCard {
  readonly explanation = input.required<ProposalExplanation>();
}
