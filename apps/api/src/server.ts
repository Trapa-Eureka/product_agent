import { createServer, type Server as HttpServer } from "node:http";

import type { NotificationHub } from "@pca/application";
import type { Principal } from "@pca/contracts";
import { principalMayAccess } from "@pca/contracts";
import {
  createRealtimeGateway,
  type AuthenticateOutcome,
  type RealtimeGateway,
} from "@pca/ws-gateway";

import { type ApiDependencies, bearerTokenOf, createApiApp, unauthenticated } from "./app";
import { originAllowed } from "./origins";

/**
 * The HTTP server: the REST app plus the WebSocket gateway on `/ws`, one
 * port, one process (ARCHITECTURE.md §11). The gateway subscribes to the
 * notification hub the application publishes to; the API never talks to
 * sockets directly.
 *
 * The upgrade is authenticated the same way a REST call is (TASK-914): a
 * bearer token, from the `Authorization` header for non-browser clients or
 * the `access_token` query parameter for browsers, which cannot set headers
 * on a WebSocket. A subscription then needs the production to be both on the
 * server's allow-list and in the principal's grant.
 *
 * Before the token, the Origin (TASK-916): a browser names where the page
 * came from, and only the server's own host or an origin in
 * `allowedOrigins` may open a socket; a query-string token without an
 * Origin is refused too, because only a non-browser client, which can set
 * the header instead, has a reason to omit it. Refusals are 403 and happen
 * before `handleUpgrade`, so no socket ever exists for a foreign page.
 */

/** The bearer token of an upgrade request: `Authorization` first, then `?access_token=`. */
export const websocketTokenOf = (request: {
  readonly url?: string | undefined;
  readonly headers: { readonly authorization?: string | undefined };
}): string | null => {
  const fromHeader = bearerTokenOf(request.headers.authorization);
  if (fromHeader !== null) return fromHeader;
  const token = new URL(request.url ?? "/", "http://localhost").searchParams.get("access_token");
  return token === null || token === "" ? null : token;
};

export type ApiServerOptions = ApiDependencies & {
  readonly hub: NotificationHub;
  readonly websocketPath?: string;
  /** Exact browser origins allowed to open the socket, besides the server's own host. Default: none. */
  readonly allowedOrigins?: readonly string[];
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
  const gateway = createRealtimeGateway<Principal>({
    hub: options.hub,
    clock: options.clock,
    authenticate: async (request): Promise<AuthenticateOutcome<Principal>> => {
      const origin = request.headers.origin;
      const headerToken = bearerTokenOf(request.headers.authorization);
      if (origin !== undefined) {
        if (
          !originAllowed({
            origin,
            host: request.headers.host,
            allowed: options.allowedOrigins ?? [],
          })
        ) {
          return {
            ok: false,
            status: 403,
            reason: `Origin ${origin} may not open a WebSocket to this server. Serve the console from this host, or list the origin in PCA_ALLOWED_ORIGINS.`,
          };
        }
      } else if (headerToken === null && websocketTokenOf(request) !== null) {
        return {
          ok: false,
          status: 403,
          reason:
            "A connection that carries its token in the query string must send an Origin header; a non-browser client sends the token as Authorization: Bearer instead.",
        };
      }
      const token = websocketTokenOf(request);
      if (token === null) {
        return { ok: false, status: 401, reason: unauthenticated("MISSING").message };
      }
      const verified = await options.identity.verify(token);
      return verified.ok
        ? { ok: true, session: verified.principal }
        : { ok: false, status: 401, reason: unauthenticated(verified.reason).message };
    },
    authorize: (productionId, _request, principal) =>
      (options.context.allowedProductionIds === "*" ||
        options.context.allowedProductionIds.includes(productionId)) &&
      principalMayAccess(principal, productionId),
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
