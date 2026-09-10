#!/usr/bin/env node
/**
 * The Playwright E2E suite (TASK-604, TESTING.md §2): three golden-scenario
 * specs driving a real browser against the real stack. `playwright.config.ts`
 * starts both servers (API, Angular dev server) itself and tears them down
 * when the run ends, so this is a single self-contained command with no
 * external service and no AWS account.
 *
 * One-time local setup this does not do for you: `pnpm exec playwright
 * install chromium` (downloads the browser binary; TESTING.md §2).
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
