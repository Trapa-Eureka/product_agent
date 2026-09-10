import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { ProductionStore } from "../state/production.store";

/**
 * DESIGN.md §2 right column, as a frame. Each panel is a stated question the
 * UI answers in order (DESIGN.md §1); the components that answer them land
 * in TASK-502 (input, detected change), TASK-503 (impact), TASK-504
 * (proposed plan and warnings), TASK-505 (approval), TASK-506 (progress).
 * Until then a panel says what it will show, never a fake answer.
 */
@Component({
  selector: "pca-change-workspace",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="workspace" aria-labelledby="ws-title">
      <h1 id="ws-title">Change Workspace</h1>
      <p class="hint">Describe a change, e.g. <code>Sarah cannot shoot Friday.</code></p>

      <div class="panel" data-panel="input">
        <h2>Your change</h2>
        <p class="pending">Input and ambiguity resolution arrive with TASK-502.</p>
      </div>
      <div class="panel" data-panel="detected">
        <h2>What changed?</h2>
        <p class="pending">The detected change card arrives with TASK-502.</p>
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
}
