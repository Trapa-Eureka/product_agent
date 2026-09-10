import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { Clock, NotificationHub } from "@pca/application";
import type { RealtimeNotification, RealtimeServerMessage } from "@pca/contracts";
import { REALTIME_PROTOCOL_VERSION, realtimeClientMessageSchema } from "@pca/contracts";

/**
 * WebSocket gateway (TASK-404, ARCHITECTURE.md §11).
 *
 * A notification channel and nothing more. It subscribes to the application's
 * notification hub and forwards each notification to the clients subscribed
 * to that production. It holds no history and replays nothing: the first
 * message on every connection says so (`canonicalSource: "rest"`), and a
 * client that reconnects re-reads job runs and proposals over REST.
 *
 * Clients choose productions explicitly, and an `authorize` hook can refuse
 * one, so a socket never receives events for a production it was not allowed
 * to name. Malformed messages get an `error` reply, not a disconnect.
 */

export type GatewayLogFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface GatewayLogger {
  log(level: "info" | "warn" | "error", event: string, fields?: GatewayLogFields): void;
}

export const silentGatewayLogger: GatewayLogger = { log: () => undefined };

export type RealtimeGatewayOptions = {
  readonly hub: NotificationHub;
  readonly clock: Clock;
  readonly logger?: GatewayLogger;
  /** Decides whether this connection may subscribe to the production. Default: everyone may. */
  readonly authorize?: (
    productionId: string,
    request: IncomingMessage,
  ) => boolean | Promise<boolean>;
  /** Productions one connection may follow at once. */
  readonly maxSubscriptionsPerClient?: number;
  /** Liveness ping period; a client that misses one is dropped. `0` disables it. */
  readonly heartbeatIntervalMs?: number;
};

export type RealtimeGateway = {
  /** Serves WebSocket upgrades on `path` of an existing HTTP server. */
  attach(server: HttpServer, path?: string): void;
  /** Starts a standalone HTTP server for the gateway; port 0 picks a free one. */
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  clientCount(): number;
  subscriberCount(productionId: string): number;
};

type ClientState = {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly subscriptions: Set<string>;
  alive: boolean;
};

const DEFAULT_PATH = "/ws";
const DEFAULT_MAX_SUBSCRIPTIONS = 16;
const DEFAULT_HEARTBEAT_MS = 30_000;

const productionOf = (notification: RealtimeNotification): string =>
  notification.type === "job"
    ? notification.event.productionId
    : notification.proposal.productionId;

/** `ws` hands frames over as a Buffer, an ArrayBuffer, or a list of Buffers. */
export const rawDataToText = (raw: RawData): string => {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
};

const parseClientMessage = (raw: RawData) => {
  let json: unknown;
  try {
    json = JSON.parse(rawDataToText(raw));
  } catch {
    return { ok: false as const, message: "Messages must be JSON objects." };
  }
  const parsed = realtimeClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false as const,
      message: `Unrecognised message: ${issue?.path.join(".") ?? "<root>"} ${issue?.message ?? "is invalid"}. Send subscribe, unsubscribe, or ping.`,
    };
  }
  return { ok: true as const, message: parsed.data };
};

export const createRealtimeGateway = (options: RealtimeGatewayOptions): RealtimeGateway => {
  const { hub, clock } = options;
  const logger = options.logger ?? silentGatewayLogger;
  const authorize = options.authorize ?? (() => true);
  const maxSubscriptions = options.maxSubscriptionsPerClient ?? DEFAULT_MAX_SUBSCRIPTIONS;
  const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;

  const server = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientState>();
  let ownHttpServer: HttpServer | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const send = (client: ClientState, message: RealtimeServerMessage): void => {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  };

  const fail = (
    client: ClientState,
    code: "MALFORMED_MESSAGE" | "PRODUCTION_UNAUTHORIZED" | "SUBSCRIPTION_LIMIT",
    message: string,
  ): void => {
    logger.log("warn", "realtime_message_rejected", { code });
    send(client, { type: "error", code, message });
  };

  const handleMessage = async (client: ClientState, raw: RawData): Promise<void> => {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      fail(client, "MALFORMED_MESSAGE", parsed.message);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "ping":
        send(client, { type: "pong", serverTime: clock.now() });
        return;
      case "unsubscribe":
        client.subscriptions.delete(message.productionId);
        send(client, { type: "unsubscribed", productionId: message.productionId });
        return;
      case "subscribe": {
        if (client.subscriptions.has(message.productionId)) {
          send(client, { type: "subscribed", productionId: message.productionId });
          return;
        }
        if (client.subscriptions.size >= maxSubscriptions) {
          fail(
            client,
            "SUBSCRIPTION_LIMIT",
            `A connection may follow at most ${maxSubscriptions} productions. Unsubscribe from one first.`,
          );
          return;
        }
        if (!(await authorize(message.productionId, client.request))) {
          fail(
            client,
            "PRODUCTION_UNAUTHORIZED",
            `This connection may not follow production ${message.productionId}.`,
          );
          return;
        }
        client.subscriptions.add(message.productionId);
        logger.log("info", "realtime_subscribed", { productionId: message.productionId });
        send(client, { type: "subscribed", productionId: message.productionId });
        return;
      }
    }
  };

  server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const client: ClientState = { socket, request, subscriptions: new Set(), alive: true };
    clients.add(client);
    logger.log("info", "realtime_connection_opened", { clients: clients.size });
    send(client, {
      type: "welcome",
      protocolVersion: REALTIME_PROTOCOL_VERSION,
      serverTime: clock.now(),
      canonicalSource: "rest",
    });
    socket.on("message", (raw: RawData) => {
      void handleMessage(client, raw);
    });
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("error", (error: Error) => {
      logger.log("warn", "realtime_socket_error", { message: error.message });
    });
    socket.on("close", () => {
      clients.delete(client);
      logger.log("info", "realtime_connection_closed", { clients: clients.size });
    });
  });

  const unsubscribeHub = hub.subscribe((notification) => {
    const productionId = productionOf(notification);
    for (const client of clients) {
      if (client.subscriptions.has(productionId)) send(client, notification);
    }
  });

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.alive) {
          logger.log("warn", "realtime_connection_dropped", { reason: "missed heartbeat" });
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }, heartbeatMs);
    heartbeat.unref();
  }

  const attach = (httpServer: HttpServer, path: string = DEFAULT_PATH): void => {
    httpServer.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
      if (requestPath !== path) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit("connection", ws, request);
      });
    });
  };

  return {
    attach,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        const httpServer = createServer((_request, response) => {
          response.writeHead(426, { "Content-Type": "text/plain" });
          response.end("This endpoint speaks WebSocket only.");
        });
        ownHttpServer = httpServer;
        attach(httpServer);
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          const boundPort = typeof address === "object" && address !== null ? address.port : port;
          resolve({ port: boundPort, url: `ws://${host}:${boundPort}${DEFAULT_PATH}` });
        });
      }),
    close: async () => {
      unsubscribeHub();
      if (heartbeat !== null) clearInterval(heartbeat);
      for (const client of clients) client.socket.close(1001, "Server shutting down");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const httpServer = ownHttpServer;
      if (httpServer !== null) {
        ownHttpServer = null;
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      }
    },
    clientCount: () => clients.size,
    subscriberCount: (productionId) =>
      [...clients].filter((client) => client.subscriptions.has(productionId)).length,
  };
};
