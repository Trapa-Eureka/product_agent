# AI Production Change Agent

[![CI](https://github.com/Trapa-Eureka/product_agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Trapa-Eureka/product_agent/actions/workflows/ci.yml)

**MCP-powered production workflow assistant**

An independent portfolio project inspired by connected film/video production workflows. The system analyzes how a change to cast, locations, scenes, or schedules affects the rest of a production, proposes safe alternatives, and applies only human-approved changes through explicit MCP tools.

> This is not a StudioBinder product and does not use StudioBinder proprietary code, data, UI, or assets.

## Screenshots

Captured from a live run of the Demo Movie fixture (GOLDEN-1, `Sarah cannot
shoot Friday.`) — see `docs/DEMO_SCRIPT.md` for the full walkthrough.

| | |
|---|---|
| ![Change workspace](docs/screenshots/01-workspace.jpg) Change workspace: input, impact, and proposal panels | ![Impact and plan](docs/screenshots/02-impact-and-plan.jpg) Impact panel (what's affected, why) and the proposed plan |
| ![Approval confirmation](docs/screenshots/03-approval-confirmation.jpg) Final confirmation before a consequential write | ![Audit trail](docs/screenshots/04-audit-trail.jpg) Full audit trail: reported → analyzed → proposed → approved → applied → verified |

Schedule after approval, confirming the write actually happened (Scene 07/12 moved off Friday):

![Schedule after approval](docs/screenshots/05-schedule-after.jpg)

## Product thesis

Production data is connected:

```text
Script / Scene
   ├─ Cast
   ├─ Location
   ├─ Props / Requirements
   ↓
Schedule
   ↓
Call Sheet
   ↓
Tasks
```

A change to one node can propagate across the workflow. The useful AI behavior is therefore not merely chat. It is **dependency-aware change analysis + safe action**.

## Core workflow

```text
User change request
        ↓
Interpret intent
        ↓
Read production state via MCP
        ↓
Deterministic dependency analysis
        ↓
Simulate candidate changes
        ↓
Validate constraints
        ↓
Explain impact and proposal
        ↓
Human approval
        ↓
Apply via MCP write tools
        ↓
Verify result + audit
```

## MVP scenarios

1. **Cast unavailable**
   - “Sarah cannot shoot Friday.”
   - Find affected scenes, schedule entries, call sheets, and tasks.
   - Propose valid alternatives.

2. **Location unavailable**
   - “The warehouse is unavailable Friday.”
   - Find all scenes scheduled there and downstream effects.
   - Propose rescheduling or replacement-location options.

3. **Scene requirement changed**
   - “Scene 18 now needs a red car.”
   - Update the proposed breakdown, identify prop/task implications, and flag schedule/call-sheet effects.

## Target stack

| Layer | Technology |
|---|---|
| Frontend | Angular + TypeScript |
| API | Node.js + Express + TypeScript |
| Database | MongoDB |
| AI | Provider adapter; AWS Bedrock target |
| Search/RAG | OpenSearch, optional for MVP |
| Async jobs | AWS SQS |
| Realtime | WebSocket |
| Agent tools | MCP |
| Infrastructure | Terraform |
| CI/CD | GitLab CI |
| Tests | Unit, integration, MCP contract, E2E |
| Local cloud dependencies | Deterministic mocks/adapters |

The stack intentionally exercises technologies relevant to the target engineering role. Local development must not require live AWS credentials.

**Free-first defaults.** This is a self-funded solo project, so paid services are never required to run it. MongoDB, Bedrock, and SQS are implemented as adapters for the portfolio, but the runtime defaults are a JSON file store, a rule-based interpreter (Ollama if installed), and an in-process queue. The whole product ships as one public npm package runnable with `npx`. See `ARCHITECTURE.md` §2 "Free-first constraint".

## Engineering principles

- Human decides consequential changes.
- LLM interprets intent and explains proposals.
- Deterministic code calculates dependencies and validates invariants.
- MCP is the controlled capability boundary.
- No direct LLM-to-database writes.
- Every mutation is auditable.
- Tests and local mocks are created early.
- Agent context is explicit and pruned when stale.

## Local development

Requires Node.js 22 or newer and pnpm. No AWS account, no MongoDB server, no
API key. The one local, one-time extra: `pnpm exec playwright install
chromium`, for the E2E suite (not run by `pnpm install` itself).

```bash
pnpm install
pnpm exec playwright install chromium
pnpm run verify
```

| Command | Purpose |
|---|---|
| `pnpm run typecheck` | TypeScript strict mode across the workspace |
| `pnpm run lint` | ESLint, including the framework-independence boundary rule |
| `pnpm run format` / `format:check` | Prettier for code (markdown is excluded) |
| `pnpm run test` | Unit suite |
| `pnpm run test:integration` | Integration suite (`*.integration.test.ts`) |
| `pnpm run test:contract` | MCP contract suite (`*.contract.test.ts`) |
| `pnpm run test:web` | Angular specs (`apps/web/src/**/*.spec.ts`), via `ng test` |
| `pnpm run test:e2e` | Playwright suite: three golden scenarios against a real browser (`e2e/`) |
| `pnpm run verify` | Local completion gate: runs the whole pipeline in order |
| `pnpm run seed` | Restores the Demo Movie fixture into the file store, clearing any stale proposals/audit trail from a previous run |
| `pnpm run token` | Mints an access token signed with `PCA_AUTH_SECRET` (`--subject`, `--role`, `--production`, `--ttl`) |

`verify` prints a per-step pass/fail summary and stops at the first failure with the command to re-run.

### Run the API

```bash
PCA_DEMO_MODE=true PCA_STORAGE=memory PCA_API_PORT=3000 pnpm exec tsx apps/api/src/main.ts
# REST under http://127.0.0.1:3000/api, WebSocket on ws://127.0.0.1:3000/ws
# GET /api/health is liveness; GET /api/ready is readiness with load counters (503 until the store answers)
```

`PCA_DEMO_MODE=true` makes the server hand anyone who asks
`GET /api/auth/demo-session` the demo coordinator's access token; the UI
fetches it on load. For anything but a local demo, set `PCA_AUTH_SECRET`
instead and mint tokens for people:

```bash
export PCA_AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
pnpm run token -- --subject jane@example.test --role approver --production PROD-DEMO
# prints a token; every request then needs  Authorization: Bearer <token>
```

The server refuses to start with neither set.

### Run the UI

```bash
pnpm --filter @pca/web start
# Angular dev server on http://localhost:4200, proxying /api and /ws to the API above
```

### Runtime environment

| Variable | Default | Meaning |
|---|---|---|
| `PCA_STORAGE` | `file` | `file`, `memory`, or `mongo` |
| `PCA_DATA_FILE` | `~/.production-change-agent/data.json` | JSON store location; created `0700`/`0600`, owner-only, and never a symbolic link |
| `PCA_DATA_FILE_PERMISSIONS` | `tighten` | An existing data file readable by others is chmodded to `0600` (`tighten`, with a warning) or refused at startup (`refuse`) |
| `PCA_MONGO_URI` | `mongodb://127.0.0.1:27017/?replicaSet=rs0` | Mongo connection; must be a replica set |
| `PCA_MONGO_DB` | `production_change_agent` | Mongo database name; with Mongo, job runs are durable too and a restart reconciles the ones it interrupted |
| `PCA_MODEL` | `rules` | `rules` (free, no network), `ollama` (later), or `bedrock` (deferred, paid) |
| `PCA_QUEUE` | `memory` | `memory` (in-process, free) or `sqs` (deferred, paid) |
| `PCA_ALLOWED_PRODUCTIONS` | (unset) | Comma-separated production IDs the API and MCP server may act on; required unless `PCA_DEMO_MODE=true`, which grants every production. Unset, blank, or `*` without the demo flag refuses to start |
| `PCA_AUTH_SECRET` | (unset) | 32+ character secret that signs access tokens; required unless `PCA_DEMO_MODE=true` |
| `PCA_DEMO_MODE` | (unset) | `true` marks a local demo: the API issues the demo coordinator's token to anyone at `/api/auth/demo-session`, and an unset allow-list means every production |
| `PCA_ALLOWED_ORIGINS` | dev UI origins in demo mode, else none | Exact browser origins (scheme, host, port) allowed to open the WebSocket, besides the API's own host; a browser page from any other origin gets 403 |
| `PCA_TLS_TERMINATED` | (unset) | `true` when the API is reached over TLS (directly or behind a terminating proxy); answers then carry `Strict-Transport-Security` |
| `PCA_RATE_LIMIT_PER_MINUTE` | `600` | Requests one client address may make per minute across the API; over it is 429 with `Retry-After` |
| `PCA_WRITE_LIMIT_PER_MINUTE` | `60` | Writes under a production (analysis, simulation, proposals, decisions, apply) one principal may make per minute |
| `PCA_MAKER_CHECKER` | `true` with a secret, `false` in demo mode | Whether the person who submitted a change may decide its proposal |
| `PCA_ACTOR_ID` | `mcp-agent` | Identity recorded for agent actions (1–200 characters; refused at startup otherwise) |
| `PCA_API_PORT` | `3000` | REST API and WebSocket port |
| `PCA_API_HOST` | `127.0.0.1` | Interface the API binds to |

## Architecture

```text
Angular Web App → Express API → { Change Analysis Domain, Repositories, Job/Queue port, Agent Orchestrator }
                                                                                  │
                                                              Model port ◄────────┤
                                                                                  └── MCP Client → MCP Server → allow-listed tools → Application services
```

The MCP server and the REST API are two delivery adapters over the same
application use cases — an MCP write tool cannot reach a capability the REST
API lacks, or the reverse. Every port (storage, model, queue) has a free
default (JSON file store, rule-based interpreter, in-process queue) and a
paid/deferred option (MongoDB, Bedrock/Ollama, SQS) documented but never
required. See `ARCHITECTURE.md` §4 for the full diagram (with every adapter
named) and §8 for the deterministic change-analysis pipeline; `docs/DEMO_SCRIPT.md`
walks the same architecture through an actual approved change.

## Trade-offs

- **Deterministic engine, narrow AI surface.** The model only interprets a
  sentence, ranks candidates the engine already validated, and writes prose —
  it never computes a dependency, a constraint, or a mutation
  (`ARCHITECTURE.md` §7–8). This makes the product's correctness testable
  without mocking a model for the invariants that matter, at the cost of a
  less "magical" demo than an agent that free-writes JSON.
- **Free-first defaults over the target stack.** MongoDB/Bedrock/SQS/Terraform
  are implemented, adapter-tested, and documented as the target stack for the
  role this is a portfolio for, but the default and only *executed* path is a
  JSON file store, a rule-based model, and an in-process queue
  (`ARCHITECTURE.md` §2). The trade-off is an MVP that cannot demonstrate live
  Bedrock latency or a real SQS retry, in exchange for `npx`-on-a-clean-machine
  reproducibility with zero account setup and zero recurring cost.
- **GitHub Actions executes; GitLab CI is documentation-only.** The repository
  is hosted on GitHub, so `.github/workflows/ci.yml` is the real, watched
  pipeline; `.gitlab-ci.yml` exists to show the same stages a GitLab-hosted
  version would run (`docs/WORK_PLAN.md`), but nothing in this repo ever
  executes it.
- **File store over an embedded database.** `PCA_STORAGE=file` writes one
  JSON document per production rather than adding a dependency like SQLite —
  simpler to inspect and reset (`pnpm run seed`). Writers serialise through an
  `O_EXCL` lock file beside the data file, so two instances or two processes
  on the same path cannot lose each other's commits — but that is one writer
  at a time, fine for a single-operator demo and not a throughput story for a
  production multi-tenant deployment.

## Limitations

- Identity is locally signed access tokens minted by the operator
  (`ARCHITECTURE.md` §15): there is no identity provider, no self-service
  sign-in, and no token revocation short of rotating the secret. Roles are
  three fixed levels, not per-production permissions.
- The rule-based model interprets a fixed set of change phrasings well
  (the three MVP scenarios and close variants); it is not a general
  natural-language understanding system, and an unrecognized sentence is
  refused rather than guessed at.
- The candidate generator is intentionally simple (§8): it finds another
  valid day, not an optimized schedule across many constraints. A
  constraint-solving generator is future work, not attempted here.
- No multi-user concurrent-editing UX (two operators changing the same
  production at once see a version conflict, not a merge).
- OpenSearch/RAG-based document search is out of scope for the MVP (`README.md`
  "Non-goals").
- The file store keeps everything on one machine's local disk and admits one
  writer at a time (a lock file, not a database); multiple API instances on
  the same path stay correct but queue behind each other, so a multi-writer
  deployment belongs on `PCA_STORAGE=mongo`. It is a single-user store: the
  directory and files are owner-only (`0700`/`0600`) and a symlinked path is
  refused, but there is no encryption at rest and no per-field access — a
  multi-user deployment needs a managed database. Change sentences are
  stored verbatim once (on the change request) for the life of the store,
  and a sentence carrying a credential is refused at intake; see `SPEC.md`
  §8 "Data policy".

## Deployment

`Dockerfile` builds the reproducible artifact; `docs/DEPLOYMENT.md` is the
security baseline a deployment must meet, most of it enforced by the server
at startup (no demo mode, a signed-token secret, an explicit production
allow-list, an encrypted and authenticated Mongo URI).

## Documentation

Read in this order:

1. `CLAUDE.md`
2. `SPEC.md`
3. `DOMAIN.md`
4. `DESIGN.md`
5. `ARCHITECTURE.md`
6. `MCP.md`
7. `TESTING.md`
8. `TASKS.md`
9. `WORKFLOW.md`
10. `docs/DEMO_SCRIPT.md` — a timed, talking-point walkthrough of the golden scenarios

## Non-goals

- Rebuilding a complete production-management platform
- Copying StudioBinder UX or proprietary behavior
- Autonomous high-impact production decisions without approval
- Direct database access by an LLM
- Making an LLM the source of truth for deterministic scheduling/dependency rules
- Billing, enterprise administration, or full screenplay editing
- Storyboard/image generation in the initial MVP

## Definition of success

A clean checkout can run locally with deterministic fixtures and mock external services. The three MVP scenarios work end-to-end. The agent can read, analyze, simulate, and propose changes; mutations require explicit approval; MCP contracts and domain invariants are tested; and the repository contains enough context and automated feedback for coding agents to complete bounded tasks with minimal human interaction.
