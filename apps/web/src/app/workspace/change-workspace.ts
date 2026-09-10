import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from "@angular/core";

import type { JobStage } from "@pca/contracts";

import { ProductionStore } from "../state/production.store";
import { AmbiguityResolution } from "./ambiguity-resolution";
import { ChangeInput } from "./change-input";
import { ChangeSubmissionService } from "./change-submission.service";
import { DetectedChangeCard } from "./detected-change-card";

/** `awaiting_approval` → "Awaiting approval"; a plain word, not TASK-506's full timeline. */
const humanizeStage = (stage: JobStage): string => {
  const spaced = stage.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * DESIGN.md §2 right column. Each panel is a stated question the UI answers
 * in order (DESIGN.md §1); the components that answer them land in
 * TASK-502 (input, ambiguity resolution, detected change — this task),
 * TASK-503 (impact), TASK-504 (proposed plan and warnings), TASK-505
 * (approval), TASK-506 (the full progress timeline). Until a panel has its
 * component it says so, never a fake answer.
 *
 * `ChangeSubmissionService` is provided here, one instance per workspace,
 * shared by `ChangeInput` and `AmbiguityResolution` through DI so both act
 * on the same tracked job. The Angular router can reuse this component
 * instance across productions, so it resets that service whenever the open
 * production changes.
 */
@Component({
  selector: "pca-change-workspace",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ChangeSubmissionService],
  imports: [ChangeInput, AmbiguityResolution, DetectedChangeCard],
  template: `
    <section class="workspace" aria-labelledby="ws-title">
      <h1 id="ws-title">Change Workspace</h1>
      <p class="hint">Describe a change, e.g. <code>Sarah cannot shoot Friday.</code></p>

      <div class="panel" data-panel="input">
        <h2>Your change</h2>
        @if (store.productionId(); as productionId) {
          <pca-change-input [productionId]="productionId" />
          @if (jobStatusLine(); as status) {
            <p
              class="job-status"
              [class.failed]="submission.job()?.stage === 'failed'"
              role="status"
            >
              {{ status }}
            </p>
          }
        } @else {
          <p class="pending">Loading production…</p>
        }
      </div>
      <div class="panel" data-panel="detected">
        <h2>What changed?</h2>
        @if (resolvingProductionId(); as productionId) {
          <pca-ambiguity-resolution [productionId]="productionId" />
        } @else if (submission.changeRequest(); as changeRequest) {
          <pca-detected-change-card [changeRequest]="changeRequest" />
        } @else {
          <p class="pending">Submit a change above to see what the system detected.</p>
        }
      </div>
      <div class="panel" data-panel="impact">
        <h2>What is affected?</h2>
        <p class="pending">BLOCKING / AFFECTED / WHY arrive with TASK-503.</p>
      </div>
      <div class="panel" data-panel="plan">
        <h2>What do you recommend?</h2>
        <p class="pending">Proposal comparison arrives with TASK-504.</p>
      </div>
      <div class="panel" data-panel="progress">
        <h2>Progress</h2>
        @if (store.openJobs().length > 0) {
          <ul>
            @for (job of store.openJobs(); track job.id) {
              <li>
                <code>{{ job.id }}</code> {{ job.stage }} ({{ job.status }})
              </li>
            }
          </ul>
        } @else {
          <p class="pending">No job in progress. The realtime timeline arrives with TASK-506.</p>
        }
      </div>
      <div class="actions">
        <button type="button" disabled>Reject</button>
        <button type="button" class="primary" disabled>Approve &amp; Apply</button>
      </div>
    </section>
  `,
  styles: `
    h1 {
      font-size: 18px;
      margin: 0 0 4px;
    }
    h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 0 0 6px;
    }
    .hint {
      color: var(--muted);
      margin: 0 0 12px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 10px;
      background: var(--panel);
    }
    .pending {
      color: var(--muted);
      margin: 0;
    }
    .job-status {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--muted);
    }
    .job-status.failed {
      color: var(--danger);
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    .actions {
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
    }
    button.primary {
      border-color: var(--accent);
    }
    button:disabled {
      opacity: 0.6;
    }
  `,
})
export class ChangeWorkspace {
  readonly store = inject(ProductionStore);
  readonly submission = inject(ChangeSubmissionService);

  /** The tracked job's production ID, but only while it is waiting on a resolution. */
  readonly resolvingProductionId = computed(() => {
    const job = this.submission.job();
    const productionId = this.store.productionId();
    return job !== null && job.stage === "resolving" && productionId !== null ? productionId : null;
  });

  /** A plain one-line status for every stage except `resolving`, which has its own panel. */
  readonly jobStatusLine = computed(() => {
    const job = this.submission.job();
    if (job === null || job.stage === "resolving") return null;
    const label = humanizeStage(job.stage);
    return job.message === undefined ? label : `${label}: ${job.message}`;
  });

  constructor() {
    // The router may reuse this component across productions; the tracked
    // job belongs to whichever production was open when it was submitted.
    effect(() => {
      this.store.productionId();
      untracked(() => this.submission.reset());
    });
  }
}
