import { Injectable, inject, signal } from "@angular/core";

import type {
  ClientStatus,
  ProductionView,
  RealtimeClient,
  SocketLike,
} from "@pca/realtime-client";
import { createRealtimeClient } from "@pca/realtime-client";

import { ProductionApi } from "../api/production-api";
import { AuthService } from "../auth/auth.service";
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

/** A browser cannot set headers on a WebSocket, so the token rides the query string (TASK-914). */
const websocketUrl = (token: string | null): string => {
  const { protocol, host } = window.location;
  const base = `${protocol === "https:" ? "wss" : "ws"}://${host}${environment.websocketPath}`;
  return token === null ? base : `${base}?access_token=${encodeURIComponent(token)}`;
};

@Injectable({ providedIn: "root" })
export class RealtimeService {
  private readonly api = inject(ProductionApi);
  private readonly auth = inject(AuthService);
  private client: RealtimeClient | null = null;
  private followedId: string | null = null;

  readonly status = signal<ClientStatus>("idle");
  readonly reconnectAttempts = signal(0);
  readonly view = signal<ProductionView | null>(null);
  /** Message of the most recent failed recovery read; cleared once a snapshot lands (TASK-910). */
  readonly lastRecoveryError = signal<string | null>(null);

  /** Test seam: a fake socket factory and URL instead of the browser's. */
  connect(options: { createSocket?: SocketFactory; url?: string } = {}): void {
    if (this.client !== null) return;
    this.client = createRealtimeClient({
      url: options.url ?? websocketUrl(this.auth.token()),
      createSocket: options.createSocket ?? browserSocket,
      recover: (productionId) => this.api.getRecovery(productionId),
      onChange: (view) => {
        if (view.productionId !== this.followedId) return;
        // A fresh snapshot supersedes whatever the last failed read reported.
        const recovered =
          view.recoveredAt !== null && view.recoveredAt !== this.view()?.recoveredAt;
        this.view.set(view);
        if (recovered) this.lastRecoveryError.set(null);
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
