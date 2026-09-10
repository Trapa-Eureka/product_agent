import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";

import type { TypedChange } from "@pca/contracts";

import { ChangeSubmissionService } from "./change-submission.service";
import { summarizeTypedChange } from "./typed-change-format";

/**
 * DESIGN.md §3: "Do not hide ambiguity." Shown only while the tracked job is
 * `resolving`. Options can share a label (two cast members both named
 * "Sarah"), so each button also shows the resolved change underneath —
 * different IDs, never the same detail line twice.
 */
@Component({
  selector: "pca-ambiguity-resolution",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (resolving(); as job) {
      <div class="resolution" role="group" aria-label="Resolve ambiguity">
        <p class="question">{{ job.message }}</p>
        <ul>
          @for (option of job.options ?? []; track option.label + "|" + summarize(option.change)) {
            <li>
              <button type="button" [disabled]="submitting()" (click)="choose(option.change)">
                <span class="label">{{ option.label }}</span>
                <span class="detail">{{ summarize(option.change) }}</span>
              </button>
            </li>
          }
        </ul>
      </div>
    }
  `,
  styles: `
    .resolution {
      display: grid;
      gap: 8px;
    }
    .question {
      margin: 0;
      font-weight: 600;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    button {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--ink);
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .label {
      font-weight: 600;
    }
    .detail {
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class AmbiguityResolution {
  readonly productionId = input.required<string>();

  readonly submission = inject(ChangeSubmissionService);

  readonly resolving = computed(() => {
    const job = this.submission.job();
    return job !== null && job.stage === "resolving" && job.options !== undefined ? job : null;
  });
  readonly submitting = computed(() => this.submission.state() === "submitting");

  summarize(change: TypedChange): string {
    return summarizeTypedChange(change);
  }

  choose(change: TypedChange): void {
    void this.submission.resolve(this.productionId(), change);
  }
}
