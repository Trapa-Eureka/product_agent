import { Injectable, computed, inject, signal } from "@angular/core";

import type { McpToolOutput, ToolError } from "@pca/contracts";

import { ApiError, ProductionApi } from "../api/production-api";
import { RealtimeService } from "../realtime/realtime.service";

/**
 * The one production the console is looking at (DESIGN.md §2 header).
 *
 * `version` is the production's own version from REST, refreshed on every
 * load and on recovery; the header shows it so a coordinator can tell the
 * plan they are reading is the plan the server has.
 */
export type LoadState = "idle" | "loading" | "ready" | "error";

@Injectable({ providedIn: "root" })
export class ProductionStore {
  private readonly api = inject(ProductionApi);
  private readonly realtime = inject(RealtimeService);

  readonly productionId = signal<string | null>(null);
  readonly production = signal<McpToolOutput<"get_production"> | null>(null);
  readonly loadState = signal<LoadState>("idle");
  readonly error = signal<ToolError | null>(null);

  readonly name = computed(() => this.production()?.name ?? "");
  /** The realtime view's version wins when present: it is the most recently recovered truth. */
  readonly version = computed(
    () => this.realtime.view()?.productionVersion ?? this.production()?.version ?? null,
  );
  readonly connection = computed(() => this.realtime.status());
  readonly openJobs = computed(
    () =>
      this.realtime
        .view()
        ?.jobs.filter((job) => job.stage !== "completed" && job.stage !== "failed") ?? [],
  );

  async open(productionId: string): Promise<void> {
    // Already have it, or already fetching it: a second navigation event must not fetch twice.
    if (
      this.productionId() === productionId &&
      this.loadState() !== "idle" &&
      this.loadState() !== "error"
    )
      return;
    this.productionId.set(productionId);
    this.loadState.set("loading");
    this.error.set(null);
    try {
      this.production.set(await this.api.getProduction(productionId));
      this.loadState.set("ready");
      this.realtime.follow(productionId);
    } catch (error) {
      this.production.set(null);
      this.loadState.set("error");
      this.error.set(
        error instanceof ApiError
          ? error.error
          : {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
      );
    }
  }
}
