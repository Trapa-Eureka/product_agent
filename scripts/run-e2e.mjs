#!/usr/bin/env node
/**
 * Placeholder for the Playwright E2E suite (TASK-604).
 *
 * The command exists from TASK-001 so `verify` has a stable shape, but it
 * reports honestly that no E2E coverage is wired yet rather than pretending to
 * pass a suite that does not exist.
 */
import { existsSync } from "node:fs";

const CONFIG = "playwright.config.ts";

if (!existsSync(CONFIG)) {
  process.stdout.write(
    "E2E_NOT_CONFIGURED: no playwright.config.ts yet.\n" +
      "The Playwright suite lands in TASK-604 (three golden scenarios, TESTING.md §2).\n" +
      "Treating this as a no-op so `verify` stays runnable.\n",
  );
  process.exit(0);
}

process.stdout.write(
  "E2E_MISCONFIGURED: playwright.config.ts exists but this runner was not updated in TASK-604.\n",
);
process.exit(1);
