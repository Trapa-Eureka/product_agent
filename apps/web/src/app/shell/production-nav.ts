import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { RouterLink, RouterLinkActive } from "@angular/router";

/** DESIGN.md §2 left column. The workspace is the production's home; the rest are views of it. */
export type NavEntry = { readonly path: string; readonly label: string; readonly exact?: boolean };

export const NAV_ENTRIES: readonly NavEntry[] = [
  { path: "", label: "Change Workspace", exact: true },
  { path: "overview", label: "Overview" },
  { path: "scenes", label: "Scenes" },
  { path: "cast", label: "Cast" },
  { path: "locations", label: "Locations" },
  { path: "schedule", label: "Schedule" },
  { path: "call-sheets", label: "Call Sheets" },
  { path: "tasks", label: "Tasks" },
  { path: "audit", label: "Audit" },
];

@Component({
  selector: "pca-production-nav",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="nav" aria-label="Production">
      <ul>
        @for (entry of entries; track entry.path) {
          <li>
            <a
              [routerLink]="['/productions', productionId(), entry.path]"
              routerLinkActive="active"
              [routerLinkActiveOptions]="{ exact: entry.exact ?? false }"
              ariaCurrentWhenActive="page"
              >{{ entry.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
  styles: `
    .nav {
      padding: 12px 8px;
      border-right: 1px solid var(--line);
      background: var(--panel);
      min-width: 180px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 2px;
    }
    a {
      display: block;
      padding: 6px 10px;
      border-radius: 6px;
      text-decoration: none;
      color: var(--ink);
    }
    a:hover {
      background: var(--bg);
    }
    a.active {
      background: var(--bg);
      font-weight: 600;
      box-shadow: inset 3px 0 0 var(--accent);
    }
  `,
})
export class ProductionNav {
  readonly productionId = input.required<string>();
  readonly entries = NAV_ENTRIES;
}
