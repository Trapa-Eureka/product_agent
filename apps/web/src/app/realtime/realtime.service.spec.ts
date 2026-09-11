import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { SocketLike } from "@pca/realtime-client";

import { ProductionApi } from "../api/production-api";
import { AuthService } from "../auth/auth.service";
import { RealtimeService } from "./realtime.service";

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  serverSays(message: unknown): void {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const NOW = "2026-09-10T12:00:00.000Z";

describe("RealtimeService", () => {
  let sockets: FakeSocket[];
  let recoveries: string[];
  let failRecovery: boolean;
  let service: RealtimeService;

  beforeEach(() => {
    sockets = [];
    recoveries = [];
    failRecovery = false;
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { token: () => "test-token" } },
        {
          provide: ProductionApi,
          useValue: {
            getRecovery: (productionId: string) => {
              recoveries.push(productionId);
              if (failRecovery) return Promise.reject(new Error("api down"));
              return Promise.resolve({
                productionId,
                productionVersion: 3,
                asOf: NOW,
                jobs: [],
                openProposals: [],
              });
            },
          },
        },
      ],
    });
    service = TestBed.inject(RealtimeService);
    service.connect({
      url: "ws://test/ws",
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
  });

  it("connects once, follows a production, and reflects the recovered view in signals", async () => {
    expect(service.status()).toBe("connecting");
    service.follow("PROD-DEMO");
    const socket = sockets[0] as FakeSocket;
    socket.serverSays({
      type: "welcome",
      protocolVersion: 1,
      serverTime: NOW,
      canonicalSource: "rest",
    });
    expect(service.status()).toBe("open");
    expect(socket.sent.map((entry) => JSON.parse(entry) as unknown)).toEqual([
      { type: "subscribe", productionId: "PROD-DEMO" },
    ]);
    socket.serverSays({ type: "subscribed", productionId: "PROD-DEMO" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recoveries).toEqual(["PROD-DEMO"]);
    expect(service.view()?.productionVersion).toBe(3);
    expect(service.view()?.recoveredAt).toBe(NOW);

    service.connect();
    expect(sockets).toHaveLength(1);
  });

  it("shows the last recovery error until a later recovery succeeds", async () => {
    failRecovery = true;
    service.follow("PROD-DEMO");
    const socket = sockets[0] as FakeSocket;
    socket.serverSays({
      type: "welcome",
      protocolVersion: 1,
      serverTime: NOW,
      canonicalSource: "rest",
    });
    socket.serverSays({ type: "subscribed", productionId: "PROD-DEMO" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.lastRecoveryError()).toBe("api down");
    expect(service.view()).toMatchObject({ recovering: true, recoveredAt: null });

    failRecovery = false;
    await service.recover();
    expect(recoveries).toEqual(["PROD-DEMO", "PROD-DEMO"]);
    expect(service.lastRecoveryError()).toBeNull();
    expect(service.view()).toMatchObject({ recovering: false, recoveredAt: NOW });
  });

  it("reports reconnecting when the socket drops, and closed after disconnect", () => {
    const socket = sockets[0] as FakeSocket;
    socket.serverSays({
      type: "welcome",
      protocolVersion: 1,
      serverTime: NOW,
      canonicalSource: "rest",
    });
    socket.onclose?.({ code: 1006, reason: "" });
    expect(service.status()).toBe("reconnecting");
    expect(service.reconnectAttempts()).toBe(1);
    service.disconnect();
    expect(service.status()).toBe("closed");
    expect(service.view()).toBeNull();
  });
});
