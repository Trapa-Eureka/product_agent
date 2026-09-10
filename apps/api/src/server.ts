import { createServer, type Server as HttpServer } from "node:http";

import type { NotificationHub } from "@pca/application";
import { createRealtimeGateway, type RealtimeGateway } from "@pca/ws-gateway";

import { type ApiDependencies, createApiApp } from "./app";

/**
 * The HTTP server: the REST app plus the WebSocket gateway on `/ws`, one
 * port, one process (ARCHITECTURE.md §11). The gateway subscribes to the
 * notification hub the application publishes to; the API never talks to
 * sockets directly.
 */

export type ApiServerOptions = ApiDependencies & {
  readonly hub: NotificationHub;
  readonly websocketPath?: string;
};

export type ApiServer = {
  readonly httpServer: HttpServer;
  readonly gateway: RealtimeGateway;
  listen(port: number, host?: string): Promise<{ port: number; url: string; websocketUrl: string }>;
  close(): Promise<void>;
};

export const createApiServer = (options: ApiServerOptions): ApiServer => {
  const app = createApiApp(options);
  const httpServer = createServer(app);
  const websocketPath = options.websocketPath ?? "/ws";
  const gateway = createRealtimeGateway({
    hub: options.hub,
    clock: options.clock,
    authorize: (productionId) =>
      options.context.allowedProductionIds === "*" ||
      options.context.allowedProductionIds.includes(productionId),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  gateway.attach(httpServer, websocketPath);

  return {
    httpServer,
    gateway,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          const boundPort = typeof address === "object" && address !== null ? address.port : port;
          resolve({
            port: boundPort,
            url: `http://${host}:${boundPort}`,
            websocketUrl: `ws://${host}:${boundPort}${websocketPath}`,
          });
        });
      }),
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
};
