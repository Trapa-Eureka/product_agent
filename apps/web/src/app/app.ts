import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { NavigationEnd, Router, RouterOutlet } from "@angular/router";
import { toSignal } from "@angular/core/rxjs-interop";
import { filter, map } from "rxjs";

import { AuthService } from "./auth/auth.service";
import { TokenPrompt } from "./auth/token-prompt";
import { environment } from "./environment";
import { RealtimeService } from "./realtime/realtime.service";
import { ProductionHeader } from "./shell/production-header";
import { ProductionNav } from "./shell/production-nav";
import { ProductionStore } from "./state/production.store";

/**
 * The console shell (DESIGN.md §2): header, production nav, and the routed
 * area where the change workspace or a production view renders. The shell
 * owns the two connection points the rest of the UI relies on: the REST
 * client through the production store, and the notification channel
 * through the realtime service. Neither is touched until the session is
 * ready (TASK-914): a server that issues no demo session gets a token
 * prompt in the routed area instead.
 */
const productionIdFromUrl = (url: string): string | null =>
  /\/productions\/([^/?#]+)/u.exec(url)?.[1] ?? null;

@Component({
  selector: "pca-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ProductionHeader, ProductionNav, TokenPrompt],
  template: `
    <div class="shell">
      <pca-production-header
        [name]="store.name()"
        [version]="store.version()"
        [connection]="store.connection()"
        [openJobs]="store.openJobs().length"
      />
      <div class="body">
        <pca-production-nav [productionId]="productionId()" />
        <main class="main">
          @if (auth.state() === "needs-token") {
            <pca-token-prompt />
          } @else {
            @if (store.loadState() === "error") {
              <section class="error" role="alert">
                <strong>{{ store.error()?.code }}</strong> {{ store.error()?.message }}
                @if (store.error()?.nextStep; as next) {
                  <div class="next">{{ next }}</div>
                }
              </section>
            }
            <router-outlet />
          }
        </main>
      </div>
    </div>
  `,
  styles: `
    .shell {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .body {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .main {
      flex: 1;
      padding: 16px 20px;
      overflow: auto;
    }
    .error {
      border: 1px solid var(--danger);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
      background: var(--panel);
    }
    .next {
      color: var(--muted);
      margin-top: 4px;
    }
  `,
})
export class App {
  readonly store = inject(ProductionStore);
  readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);

  private readonly routedProductionId = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => productionIdFromUrl(event.urlAfterRedirects)),
    ),
    { initialValue: productionIdFromUrl(this.router.url) },
  );

  readonly productionId = signal<string>(environment.defaultProductionId);

  constructor() {
    effect(() => {
      const id = this.routedProductionId();
      const ready = this.auth.state() === "ready";
      if (id !== null) this.productionId.set(id);
      if (!ready || id === null) return;
      // Untracked: the store reads its own signals while opening, and those must not
      // become dependencies of this effect, or a load failure would re-trigger the load.
      untracked(() => {
        this.realtime.connect();
        void this.store.open(id);
      });
    });
  }
}
