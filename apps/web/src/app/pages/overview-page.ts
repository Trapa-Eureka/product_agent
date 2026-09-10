import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { ProductionStore } from "../state/production.store";

/** The production as the server has it: name, ID, version, timezone. */
@Component({
  selector: "pca-overview-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Overview</h1>
    @if (store.production(); as loaded) {
      <dl class="facts">
        <dt>Name</dt>
        <dd>{{ loaded.name }}</dd>
        <dt>ID</dt>
        <dd>
          <code>{{ loaded.id }}</code>
        </dd>
        <dt>Version</dt>
        <dd>{{ loaded.version }}</dd>
        <dt>Timezone</dt>
        <dd>{{ loaded.timezone }}</dd>
      </dl>
    } @else if (store.loadState() === "loading") {
      <p role="status">Loading…</p>
    }
  `,
  styles: `
    h1 {
      font-size: 18px;
      margin: 0 0 12px;
    }
    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 16px;
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
export class OverviewPage {
  readonly store = inject(ProductionStore);
}
