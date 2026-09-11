import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createJobTracker,
  createNotificationHub,
  randomIdFactory,
  systemClock,
} from "@pca/application";
import { createLocalIdentity } from "@pca/local-auth";
import { createMemoryJobRunRepository, createMemoryQueue } from "@pca/memory-queue";
import { createMemoryStore } from "@pca/memory-store";

import {
  API_CONTENT_SECURITY_POLICY,
  CONSOLE_CONTENT_SECURITY_POLICY,
} from "../src/security-headers";
import { type ApiServer, createApiServer } from "../src/server";

/**
 * TASK-806: the API serves the prebuilt console from its own origin when
 * given a directory, with the console's CSP on those answers and the API's
 * on `/api`, and it serves nothing but `/api` otherwise.
 */
describe("console serving (TASK-806)", () => {
  let consoleDir: string;
  let server: ApiServer | null = null;

  const serve = async (options: { consoleDir?: string }): Promise<string> => {
    const clock = systemClock;
    const ids = randomIdFactory;
    server = createApiServer({
      repositories: createMemoryStore(),
      tracker: createJobTracker({ repository: createMemoryJobRunRepository(), clock, ids }),
      queue: createMemoryQueue({ clock, ids }),
      hub: createNotificationHub(),
      clock,
      ids,
      context: { actor: { type: "USER", id: "api-user" }, allowedProductionIds: "*" },
      identity: createLocalIdentity({ secret: "s".repeat(32), clock }),
      ...options,
    });
    return (await server.listen(0)).url;
  };

  beforeEach(async () => {
    consoleDir = await mkdtemp(join(tmpdir(), "pca-console-"));
    await writeFile(join(consoleDir, "index.html"), "<!doctype html><pca-root></pca-root>");
    await writeFile(join(consoleDir, "main-ABCDEFGH.js"), "console.log('console');");
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves index.html, its hashed assets, and the console's CSP outside /api", async () => {
    const base = await serve({ consoleDir });

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<pca-root>");
    expect(index.headers.get("content-security-policy")).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
    expect(index.headers.get("cache-control")).toBe("no-store");

    const asset = await fetch(`${base}/main-ABCDEFGH.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("answers index.html for a router path, so the Angular router owns it, and JSON errors under /api", async () => {
    const base = await serve({ consoleDir });

    const routed = await fetch(`${base}/productions/PROD-DEMO/schedule`);
    expect(routed.status).toBe(200);
    expect(await routed.text()).toContain("<pca-root>");

    // Under /api the token check comes first, so an unknown route without a token is 401, as JSON.
    const api = await fetch(`${base}/api/nothing-here`);
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(api.headers.get("content-security-policy")).toBe(API_CONTENT_SECURITY_POLICY);

    const post = await fetch(`${base}/`, { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("serves only /api when no console directory is given", async () => {
    const base = await serve({});
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(404);
    expect(index.headers.get("content-security-policy")).toBe(API_CONTENT_SECURITY_POLICY);
  });
});
