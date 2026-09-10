#!/usr/bin/env node
/**
 * Local completion gate (CLAUDE.md "Target root commands", TESTING.md §11).
 *
 * Runs the deterministic pipeline in order and stops at the first failure so the
 * failing boundary is obvious. Must work with no live AWS resources, no MongoDB
 * server, and no network access.
 */
import { spawnSync } from "node:child_process";

const STEPS = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "lint", args: ["run", "lint"] },
  { name: "format:check", args: ["run", "format:check"] },
  { name: "unit", args: ["run", "test"] },
  { name: "integration", args: ["run", "test:integration"] },
  { name: "contract", args: ["run", "test:contract"] },
  { name: "build", args: ["run", "build"] },
  { name: "test:web", args: ["run", "test:web"] },
  { name: "e2e", args: ["run", "test:e2e"] },
];

const results = [];
let failed = null;

for (const step of STEPS) {
  process.stdout.write(`\n▶ verify: ${step.name}\n`);
  const started = Date.now();
  const result = spawnSync("pnpm", step.args, { stdio: "inherit", shell: false });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  results.push({ name: step.name, ok, durationMs });
  if (!ok) {
    failed = { step, status: result.status ?? 1 };
    break;
  }
}

process.stdout.write("\n── verify summary ───────────────\n");
for (const { name, ok, durationMs } of results) {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(14)} ${durationMs}ms\n`);
}
const skipped = STEPS.length - results.length;
if (skipped > 0) {
  process.stdout.write(`SKIP  ${skipped} step(s) after the failure\n`);
}

if (failed) {
  process.stdout.write(`\nVERIFY_FAILED: step "${failed.step.name}" exited ${failed.status}.\n`);
  process.stdout.write(
    `Next step: re-run \`pnpm run ${failed.step.args[1]}\` and fix the reported errors.\n`,
  );
  process.exit(failed.status);
}

process.stdout.write("\nVERIFY_OK: all steps passed.\n");
