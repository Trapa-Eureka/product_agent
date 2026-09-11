import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The real entry point, booted as a process (TASK-915, SEC-002 / AUD-003):
 * the composition root must refuse to come up open, and the documented demo
 * invocation must still come up with nothing configured but the demo flag.
 */

const ENTRY = path.resolve(__dirname, "../src/main.ts");
const BASE_ENV = { PATH: process.env["PATH"], PCA_STORAGE: "memory", PCA_API_PORT: "0" };

type Booted = { readonly child: ChildProcess; readonly stderr: () => string };

const boot = (env: Record<string, string | undefined>): Booted => {
  const child = spawn("pnpm", ["exec", "tsx", ENTRY], {
    env: { ...BASE_ENV, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return { child, stderr: () => stderr };
};

const untilStderr = async (booted: Booted, pattern: RegExp, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(booted.stderr())) {
    if (booted.child.exitCode !== null) {
      throw new Error(
        `process exited ${booted.child.exitCode} before ${pattern}: ${booted.stderr()}`,
      );
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${pattern}: ${booted.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe("api entry point (TASK-915)", () => {
  const running: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of running.splice(0)) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }
  });

  it("refuses to start with no allow-list and no demo flag, saying what to set", async () => {
    const booted = boot({ PCA_AUTH_SECRET: "s".repeat(32) });
    running.push(booted.child);
    const [code] = (await once(booted.child, "exit")) as [number | null];
    expect(code).toBe(1);
    expect(booted.stderr()).toContain("PCA_ALLOWED_PRODUCTIONS is not set");
    expect(booted.stderr()).toContain("PCA_DEMO_MODE=true");
  });

  it("refuses an allow-list entry that is not a production ID", async () => {
    const booted = boot({
      PCA_AUTH_SECRET: "s".repeat(32),
      PCA_ALLOWED_PRODUCTIONS: "PROD-DEMO,bad id",
    });
    running.push(booted.child);
    const [code] = (await once(booted.child, "exit")) as [number | null];
    expect(code).toBe(1);
    // stderr is a JSON log line, so the quotes around the entry arrive escaped.
    expect(booted.stderr()).toMatch(/entry \\?"bad id\\?" is not a valid production ID/u);
  });

  it("boots the documented demo with only PCA_DEMO_MODE=true set", async () => {
    const booted = boot({ PCA_DEMO_MODE: "true" });
    running.push(booted.child);
    await untilStderr(booted, /"event":"api_start"/u);
    expect(booted.stderr()).toContain('"auth":"demo"');
    expect(booted.stderr()).toContain('"allowedProductions":"*"');
    expect(booted.stderr()).toContain('"event":"auth_demo_mode"');
  });
});
