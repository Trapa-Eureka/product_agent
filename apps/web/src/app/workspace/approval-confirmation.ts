import { ChangeDetectionStrategy, Component, computed, inject, input, output } from "@angular/core";

import { ProductionStore } from "../state/production.store";
import { ChangeSubmissionService } from "./change-submission.service";

/**
 * DESIGN.md §5: the final confirmation before the one consequential write
 * this console makes. Shown only after "Approve & Apply" is clicked;
 * `closed` fires on both Cancel and once the apply request has been sent,
 * whatever it answered — `ChangeWorkspace`'s own status line and error
 * display show the outcome, this component's job is only the gate before
 * the write, exactly as DESIGN.md §5 asks: the backend still enforces
 * approval validity, not this dialog.
 */
@Component({
  selector: "pca-approval-confirmation",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (explanation(); as explanation) {
      <div class="confirmation" role="alertdialog" aria-label="Confirm approval">
        <p class="summary">{{ explanation.headline }}</p>
        <dl>
          <dt>Operations</dt>
          <dd>{{ explanation.operations.length }}</dd>
          <dt>Current version</dt>
          <dd>{{ productionVersion() ?? "—" }}</dd>
        </dl>
        @if (warnings().length > 0) {
          <div class="warnings">
            <h4>Warnings</h4>
            <ul>
              @for (warning of warnings(); track warning) {
                <li>{{ warning }}</li>
              }
            </ul>
          </div>
        }
        <p class="notice">Approving will change the production plan.</p>
        <div class="row">
          <button type="button" (click)="closed.emit()">Cancel</button>
          <button
            type="button"
            class="primary"
            [disabled]="submitting()"
            (click)="confirm(productionId())"
          >
            {{ submitting() ? "Applying…" : "Approve & Apply" }}
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    .confirmation {
      border: 1px solid var(--accent);
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 8px;
      display: grid;
      gap: 8px;
    }
    .summary {
      font-weight: 600;
      margin: 0;
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
    h4 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 0 0 4px;
    }
    .warnings ul {
      list-style: none;
      margin: 0;
      padding: 0;
      color: var(--warn);
      font-size: 13px;
    }
    .notice {
      margin: 0;
      font-weight: 600;
    }
    .row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    button {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      cursor: pointer;
    }
    button.primary {
      border-color: var(--accent);
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
  `,
})
export class ApprovalConfirmation {
  readonly productionId = input.required<string>();
  readonly closed = output<void>();

  private readonly submission = inject(ChangeSubmissionService);
  private readonly store = inject(ProductionStore);

  readonly explanation = computed(() => this.submission.job()?.explanation ?? null);
  readonly productionVersion = computed(() => this.store.version());
  readonly submitting = computed(() => this.submission.state() === "submitting");
  readonly warnings = computed(
    () =>
      this.explanation()
        ?.effects.filter((effect) => effect.tone === "ATTENTION")
        .map((effect) => effect.text) ?? [],
  );

  async confirm(productionId: string): Promise<void> {
    await this.submission.approveAndApply(productionId);
    this.closed.emit();
  }
}
