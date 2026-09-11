#!/usr/bin/env node
/**
 * The "clean machine" acceptance for TASK-806, executed: pack this package,
 * install the tarball into an empty directory with npm (so only the declared
 * dependencies exist there, and no workspace link), and drive the installed
 * command the way a user would.
 *
 *   seed   → the Demo Movie lands in a fresh data file;
 *   serve  → the console, its hashed asset, and the demo session answer, and
 *            each of the three golden scenarios runs submit → approve →
 *            apply → verified over the REST API the console uses, the store
 *            reseeded between them;
 *   mcp    → an MCP client over stdio (this script speaks the protocol
 *            directly, so the check depends on nothing but Node) lists the
 *            tools and reads the production.
 *
 * Needs the npm registry for the tarball's dependencies, so it runs in CI
 * (`package` job) and by hand (`pnpm --filter production-change-agent smoke`),
 * not inside `verify`, which must work offline.
 */
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = "PROD-DEMO";
const SENTENCES = [
  "Sarah cannot shoot Friday.",
  "The warehouse is unavailable Friday.",
  "Scene 18 now needs a red car.",
];

const log = (line) => process.stdout.write(`smoke: ${line}\n`);
const fail = (message) => {
  throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
};

// A stage that hangs (a server that never answers, a client that never
// hears back) fails with its name instead of holding CI to its timeout.
let stage = "start";
const watchdog = setTimeout(() => {
  process.stderr.write(`smoke: timed out during "${stage}"\n`);
  process.exit(1);
}, 8 * 60_000);
watchdog.unref();

const work = await mkdtemp(join(tmpdir(), "pca-smoke-"));
// Under a dot-directory on purpose: that is where `npx` keeps packages
// (`~/.npm/_npx/…`), and 0.1.0 served its console from there as 404.
const install = join(work, ".npm", "_npx", "project");
const dataFile = join(work, "data.json");
let serverProcess = null;
let mcpProcess = null;

try {
  // 1. Pack and install as a user would.
  log("packing");
  run("pnpm", ["pack", "--pack-destination", work], { cwd: here });
  const tarball = (await readdir(work)).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) fail("pnpm pack produced no tarball");
  await mkdir(install, { recursive: true });
  await writeFile(join(install, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  log(`installing ${tarball} with npm`);
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", join(work, tarball)], {
    cwd: install,
  });
  // The installed command as npm linked it: the bin entry must exist, and
  // the bundle runs through node directly rather than `npm exec`, so a
  // signal reaches the server itself, not a wrapper whose orphaned child
  // would keep an inherited pipe (and this process) alive.
  await access(join(install, "node_modules", ".bin", "production-change-agent"));
  const cli = join(install, "node_modules", "production-change-agent", "dist", "cli.js");
  const npx = (args, options = {}) =>
    run(process.execPath, [cli, ...args], {
      cwd: install,
      env: { ...process.env, PCA_DATA_FILE: dataFile },
      ...options,
    });

  // 2. seed
  stage = "seed";
  const seeded = npx(["seed"]);
  if (!seeded.includes("Demo Movie restored")) fail(`seed said: ${seeded}`);
  log("seed ok");

  // 3. serve
  stage = "serve";
  const port = await freePort();
  serverProcess = spawn(process.execPath, [cli, "serve"], {
    cwd: install,
    env: { ...process.env, PCA_DATA_FILE: dataFile, PCA_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  serverProcess.stdout.on("data", (chunk) => (serverLog += chunk));
  serverProcess.stderr.on("data", (chunk) => (serverLog += chunk));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {
      // not up yet
    }
    if (serverProcess.exitCode !== null) fail(`serve exited early:\n${serverLog}`);
    await sleep(500);
  }
  const index = await fetch(`${base}/`);
  const html = await index.text();
  if (!index.ok || !html.includes("<pca-root>")) fail(`console index: ${index.status}`);
  const asset = /src="(main-[A-Z0-9]+\.js)"/u.exec(html)?.[1];
  if (asset === undefined) fail("console index names no main bundle");
  const script = await fetch(`${base}/${asset}`);
  if (!script.ok || !(script.headers.get("cache-control") ?? "").includes("immutable")) {
    fail(`console asset ${asset}: ${script.status} ${script.headers.get("cache-control")}`);
  }
  if (!(index.headers.get("content-security-policy") ?? "").startsWith("default-src 'self'")) {
    fail("console answered without the console CSP");
  }
  log("console served");
  const session = await (await fetch(`${base}/api/auth/demo-session`)).json();
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  const api = async (method, path, body) => {
    const reply = await fetch(`${base}/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await reply.json();
    if (!reply.ok) fail(`${method} ${path} → ${reply.status} ${JSON.stringify(json)}`);
    return json;
  };
  const waitFor = async (jobId, stages) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const job = await api("GET", `/productions/${DEMO}/jobs/${jobId}`);
      if (job.stage === "failed") fail(`job ${jobId} failed: ${job.message}`);
      if (stages.includes(job.stage)) return job;
      await sleep(250);
    }
    fail(`job ${jobId} never reached ${stages.join("/")}`);
  };

  // 4. The three golden scenarios, the way the console drives them.
  for (const text of SENTENCES) {
    stage = `golden "${text}"`;
    npx(["seed"]);
    const before = (await api("GET", `/productions/${DEMO}`)).version;
    const submitted = await api("POST", `/productions/${DEMO}/changes`, { text });
    const waiting = await waitFor(submitted.job.id, ["awaiting_approval"]);
    const decided = await api(
      "POST",
      `/productions/${DEMO}/proposals/${waiting.proposalId}/decision`,
      {
        decision: "APPROVE",
        jobId: waiting.id,
      },
    );
    await api("POST", `/productions/${DEMO}/proposals/${waiting.proposalId}/apply`, {
      approvalId: decided.approval.id,
      expectedProductionVersion: decided.proposal.baseProductionVersion,
      idempotencyKey: `apply:${decided.proposal.id}:${decided.proposal.digest.slice(0, 16)}`,
      jobId: waiting.id,
    });
    const done = await waitFor(waiting.id, ["completed"]);
    if (done.status !== "COMPLETED") fail(`"${text}" ended ${done.status}: ${done.message}`);
    const after = (await api("GET", `/productions/${DEMO}`)).version;
    if (after !== before + 1) fail(`"${text}": version ${before} → ${after}`);
    log(`golden "${text}" applied and verified (version ${before} → ${after})`);
  }
  serverProcess.kill("SIGTERM");
  await sleep(500);

  // 5. mcp over stdio: initialize, list tools, read the production.
  stage = "mcp";
  mcpProcess = spawn(process.execPath, [cli, "mcp"], {
    cwd: install,
    env: { ...process.env, PCA_DATA_FILE: dataFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let mcpLog = "";
  mcpProcess.stderr.on("data", (chunk) => (mcpLog += chunk));
  mcpProcess.on("exit", (code) => {
    if (stage === "mcp") process.stderr.write(`smoke: mcp exited (${code}):\n${mcpLog}`);
  });
  const pending = new Map();
  mcpProcess.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 20_000);
    });
  const notify = (method, params) =>
    mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  if (init.error) fail(`mcp initialize: ${JSON.stringify(init.error)}`);
  notify("notifications/initialized", {});
  const tools = await request("tools/list", {});
  const names = tools.result.tools.map((tool) => tool.name);
  for (const expected of ["get_production", "analyze_change_impact", "apply_approved_proposal"]) {
    if (!names.includes(expected)) fail(`mcp tools/list lacks ${expected}: ${names.join(", ")}`);
  }
  const read = await request("tools/call", {
    name: "get_production",
    arguments: { productionId: DEMO },
  });
  if (read.error || read.result.isError) fail(`mcp get_production: ${JSON.stringify(read)}`);
  if (!JSON.stringify(read.result).includes("Demo Movie"))
    fail("mcp get_production did not name the Demo Movie");
  log(`mcp ok (${names.length} tools)`);
  stage = "done";
  mcpProcess.kill("SIGTERM");
  log("all checks passed");
} finally {
  serverProcess?.kill("SIGKILL");
  mcpProcess?.kill("SIGKILL");
  await rm(work, { recursive: true, force: true });
}
// Explicit: nothing a child left behind may keep this process alive.
process.exit(0);
