import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";

import type { JobStage } from "@pca/contracts";

import { ProductionStore } from "../state/production.store";
import { AmbiguityResolution } from "./ambiguity-resolution";
import { ApprovalConfirmation } from "./approval-confirmation";
import { CandidateComparisonPanel } from "./candidate-comparison";
import { ChangeInput } from "./change-input";
import { ChangeSubmissionService } from "./change-submission.service";
import { DetectedChangeCard } from "./detected-change-card";
import { ImpactPanel } from "./impact-panel";
import { ProposalCard } from "./proposal-card";

/** `awaiting_approval` → "Awaiting approval"; a plain word, not TASK-506's full timeline. */
const humanizeStage = (stage: JobStage): string => {
  const spaced = stage.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * DESIGN.md §2 right column. Each panel is a stated question the UI answers
 * in order (DESIGN.md §1); the components that answer them land in
 * TASK-502 (input, ambiguity resolution, detected change), TASK-503
 * (impact), TASK-504 (proposed plan and candidate comparison — this task),
 * TASK-505 (approval — this task), TASK-506 (the full progress timeline).
 * Until a panel has its component it says so, never a fake answer.
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
  imports: [
    ChangeInput,
    AmbiguityResolution,
    DetectedChangeCard,
    ImpactPanel,
    ProposalCard,
    CandidateComparisonPanel,
    ApprovalConfirmation,
  ],
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
        <pca-impact-panel [explanation]="submission.impactExplanation()" />
      </div>
      <div class="panel" data-panel="plan">
        <h2>What do you recommend?</h2>
        @if (submission.job()?.explanation; as explanation) {
          <pca-proposal-card [explanation]="explanation" />
          @if (submission.job()?.candidateComparison; as comparison) {
            <pca-candidate-comparison [comparison]="comparison" />
          }
        } @else {
          <p class="pending">Submit a change above to see the recommended plan.</p>
        }
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
      @if (decidableProductionId(); as productionId) {
        <div class="actions">
          <button type="button" [disabled]="deciding()" (click)="reject(productionId)">
            Reject
          </button>
          <button
            type="button"
            class="primary"
            [disabled]="deciding()"
            (click)="confirmingApproval.set(true)"
          >
            Approve &amp; Apply
          </button>
        </div>
        @if (confirmingApproval()) {
          <pca-approval-confirmation
            [productionId]="productionId"
            (closed)="confirmingApproval.set(false)"
          />
        }
      } @else {
        <div class="actions">
          <button type="button" disabled>Reject</button>
          <button type="button" class="primary" disabled>Approve &amp; Apply</button>
        </div>
      }
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

  /** DESIGN.md §5: Reject and Approve & Apply act only on a job actually awaiting a decision. */
  readonly decidableProductionId = computed(() => {
    const job = this.submission.job();
    const productionId = this.store.productionId();
    return job !== null && job.stage === "awaiting_approval" && productionId !== null
      ? productionId
      : null;
  });
  readonly deciding = computed(() => this.submission.state() === "submitting");
  readonly confirmingApproval = signal(false);
  /** A `computed`, not the run itself: this must not re-fire on every update to the same job. */
  private readonly trackedJobId = computed(() => this.submission.job()?.id ?? null);

  constructor() {
    // The router may reuse this component across productions; the tracked
    // job belongs to whichever production was open when it was submitted.
    effect(() => {
      this.store.productionId();
      untracked(() => this.submission.reset());
    });
    // A stale "confirming" flag must not reopen the dialog for a later, different job.
    effect(() => {
      this.trackedJobId();
      untracked(() => this.confirmingApproval.set(false));
    });
  }

  reject(productionId: string): void {
    void this.submission.reject(productionId);
  }
}
