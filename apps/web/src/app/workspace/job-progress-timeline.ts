import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

import type { JobRun } from "@pca/contracts";

import { buildJobProgress, type ProgressStepStatus } from "./job-progress-format";

const ICONS: Readonly<Record<ProgressStepStatus, string>> = {
  done: "✓",
  active: "●",
  pending: "○",
};

/**
 * DESIGN.md §6 compact progress timeline. Purely presentational — every
 * step, its status, and the failure text come from `buildJobProgress`; this
 * component only lays them out. Status is never color-only (DESIGN.md §8):
 * each step also carries its own icon and, for the active step, bold text.
 */
@Component({
  selector: "pca-job-progress-timeline",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (progress(); as progress) {
      @if (progress.kind === "steps") {
        <ol>
          @for (step of progress.steps; track step.stage) {
            <li [attr.data-status]="step.status">
              <span class="icon" aria-hidden="true">{{ icons[step.status] }}</span>
              <span class="label">{{ step.label }}</span>
            </li>
          }
        </ol>
      } @else {
        <p class="failure" role="status">
          <strong>{{ progress.label }} failed.</strong> {{ progress.message }}
        </p>
      }
    } @else {
      <p class="pending">No job in progress.</p>
    }
  `,
  styles: `
    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    li {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .icon {
      width: 1em;
      text-align: center;
    }
    li[data-status="done"] {
      color: var(--ink);
    }
    li[data-status="active"] .label {
      color: var(--accent);
      font-weight: 600;
    }
    li[data-status="pending"] {
      color: var(--muted);
    }
    .failure {
      color: var(--danger);
      margin: 0;
    }
    .pending {
      color: var(--muted);
      margin: 0;
    }
  `,
})
export class JobProgressTimeline {
  readonly job = input.required<JobRun | null>();
  readonly progress = computed(() => buildJobProgress(this.job()));
  readonly icons = ICONS;
}
