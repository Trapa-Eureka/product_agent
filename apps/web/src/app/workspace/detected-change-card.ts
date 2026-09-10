import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

import type { ChangeRequest } from "@pca/contracts";

import { formatTypedChange } from "./typed-change-format";

/**
 * DESIGN.md §3 "Detected change card": normalized type, resolved entity,
 * date/scene.
 *
 * Two fields DESIGN.md lists are not shown, for reasons rooted in the
 * architecture rather than omitted by oversight: confidence is the model's
 * own score, computed during interpretation and never written into the
 * persisted `ChangeRequest`, so there is nothing here to read it from; an
 * editable correction would mean pausing the pipeline after interpretation
 * for a human edit, but `runChangeAgent` (TASK-305) runs interpret through
 * propose as one loop with no such pause point today. Both are recorded as
 * known gaps rather than faked.
 */
@Component({
  selector: "pca-detected-change-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <p class="type">{{ formatted().typeLabel }}</p>
      <p class="said">
        You said: <em>{{ changeRequest().rawText }}</em>
      </p>
      <dl>
        @for (field of formatted().fields; track field.label) {
          <dt>{{ field.label }}</dt>
          <dd>{{ field.value }}</dd>
        }
      </dl>
    </div>
  `,
  styles: `
    .card {
      display: grid;
      gap: 6px;
    }
    .type {
      margin: 0;
      font-weight: 600;
    }
    .said {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 2px 12px;
      margin: 0;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
    }
  `,
})
export class DetectedChangeCard {
  readonly changeRequest = input.required<ChangeRequest>();
  readonly formatted = computed(() => formatTypedChange(this.changeRequest().payload));
}
