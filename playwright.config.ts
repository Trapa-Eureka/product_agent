import { defineConfig } from "@playwright/test";

/**
 * TASK-604: the three golden-scenario E2E specs (TESTING.md §2, §4),
 * driving a real Chromium against the real stack — Angular dev server →
 * API → rule-based model → application/domain engine → memory store
 * (TESTING.md §2 "E2E"). Both servers below are started by Playwright
 * itself, on fixed ports matching `apps/web/proxy.conf.json`, and torn
 * down when the run ends. No external service, no AWS account.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["line"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "pnpm exec tsx apps/api/e2e/server.ts",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: !process.env["CI"],
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @pca/web exec ng serve --port 4200 --host 127.0.0.1",
      url: "http://127.0.0.1:4200",
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
