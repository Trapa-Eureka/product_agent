import { Injectable, inject, signal } from "@angular/core";

import type {
  ClientStatus,
  ProductionView,
  RealtimeClient,
  SocketLike,
} from "@pca/realtime-client";
import { createRealtimeClient } from "@pca/realtime-client";

import { ProductionApi } from "../api/production-api";
import { environment } from "../environment";

/**
 * The console's window onto the notification channel (ARCHITECTURE.md §11).
 *
 * Wraps the framework-independent reconnecting client with Angular signals:
 * one for the connection status, one for the followed production's view.
 * Recovery reads go through the REST client, so this service never knows
 * a socket message is anything but a hint to look again.
 */
export type SocketFactory = (url: string) => SocketLike;

const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

const websocketUrl = (): string => {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${environment.websocketPath}`;
};

@Injectable({ providedIn: "root" })
export class RealtimeService {
  private readonly api = inject(ProductionApi);
  private client: RealtimeClient | null = null;
  private followedId: string | null = null;

  readonly status = signal<ClientStatus>("idle");
  readonly reconnectAttempts = signal(0);
  readonly view = signal<ProductionView | null>(null);
  readonly lastRecoveryError = signal<string | null>(null);

  /** Test seam: a fake socket factory and URL instead of the browser's. */
  connect(options: { createSocket?: SocketFactory; url?: string } = {}): void {
    if (this.client !== null) return;
    this.client = createRealtimeClient({
      url: options.url ?? websocketUrl(),
      createSocket: options.createSocket ?? browserSocket,
      recover: (productionId) => this.api.getRecovery(productionId),
      onChange: (view) => {
        if (view.productionId === this.followedId) this.view.set(view);
      },
      onStatus: (status, attempt) => {
        this.status.set(status);
        this.reconnectAttempts.set(attempt);
      },
      onRecoveryError: (_productionId, error) => {
        this.lastRecoveryError.set(error instanceof Error ? error.message : String(error));
      },
    });
    this.client.connect();
  }

  follow(productionId: string): void {
    if (this.followedId === productionId) return;
    if (this.followedId !== null) this.client?.unfollow(this.followedId);
    this.followedId = productionId;
    this.view.set(null);
    this.client?.follow(productionId);
  }

  recover(): Promise<void> {
    return this.followedId === null || this.client === null
      ? Promise.resolve()
      : this.client.recover(this.followedId);
  }

  disconnect(): void {
    this.client?.close();
    this.client = null;
    this.followedId = null;
    this.view.set(null);
  }
}
