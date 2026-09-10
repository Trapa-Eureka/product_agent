import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import type { ClientStatus } from "@pca/realtime-client";

/**
 * DESIGN.md §2: "Production: Demo Movie … Status / Version". Status is the
 * connection to the notification channel; version is the production's own.
 * Every state is a word as well as a colour (DESIGN.md §8).
 */
@Component({
  selector: "pca-production-header",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="header">
      <div class="title">
        <span class="label">Production:</span>
        <span class="name">{{ name() || "…" }}</span>
      </div>
      <div class="status" role="status" aria-live="polite">
        <span class="chip" [attr.data-state]="connection()">{{ connectionLabel() }}</span>
        <span class="chip" data-state="version">Version {{ version() ?? "—" }}</span>
        @if (openJobs() > 0) {
          <span class="chip" data-state="busy"
            >{{ openJobs() }} job{{ openJobs() === 1 ? "" : "s" }} in progress</span
          >
        }
      </div>
    </header>
  `,
  styles: `
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .title {
      display: flex;
      gap: 8px;
      align-items: baseline;
    }
    .label {
      color: var(--muted);
    }
    .name {
      font-weight: 600;
      font-size: 16px;
    }
    .status {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 12px;
    }
    .chip[data-state="open"] {
      border-color: var(--ok);
    }
    .chip[data-state="reconnecting"],
    .chip[data-state="connecting"] {
      border-color: var(--warn);
    }
    .chip[data-state="closed"] {
      border-color: var(--danger);
    }
    .chip[data-state="busy"] {
      border-color: var(--accent);
    }
  `,
})
export class ProductionHeader {
  readonly name = input.required<string>();
  readonly version = input.required<number | null>();
  readonly connection = input.required<ClientStatus>();
  readonly openJobs = input(0);

  connectionLabel(): string {
    switch (this.connection()) {
      case "open":
        return "Live";
      case "connecting":
        return "Connecting";
      case "reconnecting":
        return "Reconnecting";
      case "closed":
        return "Offline";
      case "idle":
        return "Not connected";
    }
  }
}
