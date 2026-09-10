# Architecture

## 1. Technology Stack

### Frontend

- Angular
- TypeScript
- WebSocket client

### Backend

- Node.js
- Express
- TypeScript

### Database

- MongoDB

### AI / Model

- AWS Bedrock
- Provider-independent `ModelPort`
- Deterministic `FakeModelAdapter` for local testing

### Agent Integration

- Model Context Protocol (MCP)
- Explicit read / analyze / simulate / write tool contracts
- Human approval boundary for consequential writes

### Search

- AWS OpenSearch
- Optional for MVP
- Used for production document search/RAG, not dependency analysis

### Async Processing

- AWS SQS
- Dead Letter Queue
- Local deterministic queue adapter

### Realtime

- WebSocket

### Infrastructure

- AWS
- Terraform

### CI/CD

- GitLab CI

### Testing

- TypeScript strict mode
- Unit tests
- Integration tests
- MCP contract tests
- Playwright E2E
- Deterministic local mocks

### Local Development

- FakeModelAdapter
- In-memory/fake queue
- deterministic Demo Movie fixtures
- MongoDB local/test environment

## 2. Why This Stack

### Angular

Angular is intentionally used instead of the author's usual
React/Next.js stack to demonstrate the ability to work with the
frontend technology used by the target production SaaS environment.

### MongoDB

MongoDB is used as the operational data store to practice document
modeling and indexing for connected production-domain data.

### AWS Bedrock

Bedrock is used behind a provider abstraction so AI orchestration
remains independent of a specific model provider.

### SQS

Production change analysis and AI jobs can be asynchronous.
SQS provides retries, decoupling, and a production-ready queue model.

### MCP

MCP creates an explicit capability boundary between the AI agent and
the production application rather than allowing unrestricted database
or API access.

### Terraform

AWS resources are expressed as infrastructure as code so the system
can be reproduced, reviewed, and tested consistently.

### WebSocket

Realtime events expose long-running agent stages such as analysis,
simulation, approval, application, and verification.

### OpenSearch

OpenSearch is reserved for document retrieval and RAG.
It must not replace deterministic production dependency queries.

### Free-first constraint

This is an independent, self-funded portfolio project built by a single
developer. There is no budget for metered cloud services, so every
component that would bill per use has a free, zero-install adapter that is
the **runtime default**, while the target-stack adapter remains in the
codebase to demonstrate the intended production shape.

| Concern | Target adapter (portfolio) | Default adapter (free, runs anywhere)                         |
| ------- | -------------------------- | ------------------------------------------------------------- |
| Store   | MongoDB                    | JSON file store (`PCA_STORAGE=file`)                          |
| Model   | AWS Bedrock                | Rule-based interpreter, Ollama if present (`PCA_MODEL=rules`) |
| Queue   | AWS SQS                    | In-process queue                                              |
| Search  | OpenSearch                 | none (optional feature, excluded from MVP)                    |

Consequences:

- domain and application packages never see which adapter is active;
- the published npm package runs the full product on a clean machine with
  `npx` and no credentials;
- Bedrock, SQS, and Terraform `apply` are exercised only when a budget or
  AWS account exists (see `TASKS.md` items marked DEFERRED).

Decision record: `docs/decisions/0001-free-first-adapters.md`.

## 3. Goals

- Strongly typed, agent-friendly codebase
- Explicit domain boundaries
- Deterministic change analysis
- Safe MCP capability boundary
- Cloud-portable local development
- Fast automated feedback
- Architecture that exercises Angular, Node/Express, MongoDB, AWS concepts, Terraform, GitLab CI, WebSocket, and MCP

## 4. High-level architecture

```text
Angular Web App
      │ REST / WebSocket
      ▼
Express API / Application Layer
      │
      ├──────────────► Change Analysis Domain
      │                    │
      │                    └── deterministic rules
      │
      ├──────────────► MongoDB repositories
      │
      ├──────────────► Job/Queue port ──► SQS adapter
      │
      └──────────────► Agent Orchestrator
                              │
                              ├── Model port ──► Bedrock adapter
                              │
                              └── MCP Client
                                      │
                                      ▼
                                  MCP Server
                                      │
                              allow-listed tools
                                      │
                                      ▼
                              Application services
```

Important: MCP write tools call application services. They do not bypass domain rules by writing directly to MongoDB.

## 5. Suggested repository

```text
product_agent/
├── apps/
│   ├── web/                 # Angular
│   ├── api/                 # Express API
│   └── mcp-server/          # MCP transport/tool registration
├── packages/
│   ├── domain/              # entities, invariants, change engine
│   ├── application/         # use cases, and the ports they depend on
│   ├── contracts/           # zod/types shared across boundaries
│   ├── bootstrap/           # composition root: selects adapters from env
│   ├── adapters/
│   │   ├── file-store/      # JSON file repositories (default)
│   │   ├── memory-store/    # in-memory repositories
│   │   ├── memory-queue/    # in-process queue (free default)
│   │   ├── ws-gateway/      # WebSocket notifications (ws)
│   │   └── mongo-store/     # MongoDB repositories (TASK-102)
│   ├── realtime-client/     # reconnecting client (browser or Node)
│   ├── fixtures/            # deterministic Demo Movie
│   └── test-support/        # fakes, builders, shared contract suites
├── infra/
│   └── terraform/
├── docs/
├── CLAUDE.md
├── SPEC.md
├── DOMAIN.md
├── DESIGN.md
├── ARCHITECTURE.md
├── MCP.md
├── TESTING.md
├── TASKS.md
└── WORKFLOW.md
```

A monorepo is recommended so shared contracts and verification can be run from one root.

## 6. Layering

### Domain

Pure TypeScript. No Express, Angular, MongoDB, AWS SDK, MCP SDK, or model SDK imports.

Owns:

- entities/value objects;
- invariants;
- dependency graph;
- impact analysis;
- proposal validation;
- schedule compatibility rules used by MVP.

### Where entity shapes live

`packages/contracts` owns the schemas and is the single source of truth for
entity shape. The domain consumes the inferred types rather than restating them,
so a field cannot mean one thing in Mongo, another in an MCP response, and a
third in the UI.

This does not weaken the domain boundary. A schema library is not a framework:
the domain still imports no HTTP server, database driver, cloud SDK, MCP
transport, or model SDK, and the ESLint boundary rule enforces that.

### Application

Coordinates use cases:

- submit change;
- resolve entities;
- analyze impact;
- simulate proposal;
- approve/reject;
- apply proposal;
- verify proposal.

Depends on interfaces/ports, not concrete infrastructure.

### Adapters

Concrete implementations:

- Mongo repositories;
- Bedrock model;
- fake deterministic model;
- SQS;
- in-memory queue;
- OpenSearch;
- WebSocket event publisher.

### Delivery

- Express HTTP routes
- WebSocket gateway
- MCP server
- Angular UI

### REST API

`apps/api` (TASK-110) is an adapter like the MCP server. Routes under
`/api/productions/:productionId` parse HTTP, hand the application a typed
input and a call context, and render the result. Reads, analysis, proposal,
apply, and verify routes run the same tool handlers as MCP
(`@pca/mcp-server/handlers`), so a route and a tool validate the same input,
run the same use case, and validate the same output; a route cannot expose a
capability the tool surface lacks. Two things are REST-only because a human
does them: recording a decision on a proposal, and submitting a change as a
job whose progress the UI follows (`POST .../changes`, resumable at
`resolving` with the chosen change). Apply runs synchronously, or as a job
continuing a run's timeline when `jobId` is given. Errors are the same
`ToolError` as everywhere, with the HTTP status derived from the code and
never chosen per route. Authorization is the server-side production
allow-list, checked before any handler runs; the acting identity is the
`X-Actor-Id` header (a deployment puts an auth layer in front);
`X-Correlation-Id` is honoured and always echoed. The WebSocket gateway is
attached to the same HTTP server on `/ws`.

### Angular UI

`apps/web` (TASK-501) is Angular 21, zoneless, signals, standalone
components. The shell is DESIGN.md §2: a header with the production name,
the connection status as a word, the version, and jobs in progress; the
production nav; and a routed area holding the change workspace or a view of
the production. Two services are the UI's only connection points:
`ProductionApi`, a thin REST client typed by the shared contracts whose
errors carry the server's `ToolError`, and `RealtimeService`, which wraps
`@pca/realtime-client` in signals and recovers over REST. `ProductionStore`
owns the open production and its version, which the header shows so a
coordinator can tell the plan they are reading is the plan the server has.
The dev server proxies `/api` and `/ws` to the API. The app type-checks
itself with the DOM lib (the root TypeScript project excludes it) and is
built with AOT and strict templates in the verify gate; its specs run with
vitest and jsdom through `ng test`. Serving it (`ng serve`, TASK-604's E2E
`webServer`) needed one fix: the dev server's Vite-based dependency
pre-bundler resolves `@pca/contracts`/`@pca/realtime-client` as if they were
ordinary `node_modules` packages, using a plain esbuild scan that does not
resolve their extensionless relative imports (`export * from "./entities"`)
the way the rest of the toolchain (`tsc`, vitest, the `ng build`/`ng test`
builders) does — so `angular.json`'s `serve` options set `prebundle: false`.
The two packages are still bundled into the app, just without that
pre-scan; `ng build`/`ng test` were never affected, since prebundling is a
dev-server-only step.

The change workspace (TASK-502) adds a component-scoped
`ChangeSubmissionService`, one instance per workspace, provided by
`ChangeWorkspace` and shared by its `ChangeInput` and `AmbiguityResolution`
children through DI. It follows §11's rule literally: a live event for the
job it is tracking is read only as a hint to re-read that job over REST,
never as the update itself, which is what lets a field the socket event
cannot carry (the interpretation `options` a `resolving` run holds) reach
the UI correctly regardless of timing. Because the Angular router can reuse
the workspace component instance across productions, `ChangeWorkspace`
resets the service whenever the open production changes.

The impact panel (TASK-503) follows the same shape once more: the DESIGN.md
§3 explanation is application logic (`analyzeChangeImpact`'s `explanation`
field, via `describeImpact`), a REST-only route
(`POST .../analysis/explanation`) exposes it because the MCP tool contract
has no room for it, `ChangeSubmissionService` fetches it once the tracked
job's change request is known, and `ImpactPanel` renders it with no logic of
its own — every line of text is the server's.

The proposal card and candidate comparison (TASK-504) take a third path:
`runChangeAgent` already builds `describeProposal`'s structured card, and
already ranks/rejects shoot days for a scheduling change, once, synchronously,
at proposal-creation time. Recomputing either later would mean re-simulating
against whatever the production has become since, which is not the world the
approved proposal describes. So the ANALYZE_CHANGE job handler carries both
onto the tracked `JobRun` the same way `options` carries ambiguity (TASK-502,
TASK-403): no REST route, no `ChangeSubmissionService` fetch — they arrive
with the job the service already reads. `ProposalCard` and
`CandidateComparisonPanel` render them, again with no logic of their own.

The approval flow (TASK-505) is `ChangeSubmissionService`'s last two
methods: `reject` and `approveAndApply`, both gated in the UI to a job at
`awaiting_approval` and both still fully re-checked by the backend (DESIGN.md
§5, "the backend, not the UI, enforces approval validity"). `reject` posts
the decision with the job's ID, which the decision route uses to complete
that job server-side (`awaiting_approval → completed`, the edge
`JOB_STAGE_TRANSITIONS` already named but nothing exercised before this
task) — best-effort and idempotent, since the decision itself is what
matters and a repeat rejection finds the job already terminal.
`approveAndApply` decides `APPROVE`, then applies as a job continuing the
same run's timeline using `expectedProductionVersion` from the decision's
own response (the version the proposal was actually built against) rather
than reading the production's current version and hoping nothing moved. The
UI's own gate before that call — `ApprovalConfirmation` — is what DESIGN.md
§5 asks for: a summary, the operation count, warnings, the current version,
and the fixed notice that approving changes the plan.

The progress timeline (TASK-506) replaces the workspace's earlier raw
job-list panel with DESIGN.md §6's ✓/●/○ list, derived by a pure function,
`buildJobProgress`, from the tracked job's `history` — no fetch, no state of
its own, same as `describeImpact`/`describeProposal` on the server side.
`JobProgressTimeline` renders its result with no logic of its own. It reads
`ChangeSubmissionService.job`, the same tracked job every other panel reads,
not `ProductionStore.openJobs` (which still exists, for the header's open-job
count) — the timeline is always about the one change this workspace is
following, not every job the production happens to have open.

The Schedule and Audit nav views (TASK-507, TASK-508) needed no new backend
surface at all — `get_schedule`/`get_scene` and the `/audit` route (TASK-110)
already existed — so both are pure Angular polish on views the shell
(TASK-501) had left as placeholders. `SchedulePage` resolves every scene ID
a shoot day names through `get_scene` (a scene ID is opaque, never assumed
to encode anything) and lays out `buildScheduleRows`'s result, one shoot day
per section; "before/after" is simply always showing the schedule the server
currently has, so approving a change and returning here is the comparison.
`AuditPage` turns each `AuditEvent` into one DESIGN.md §7 sentence via
`describeAuditEvent`, reading only its `action` and structured `metadata` —
never a model's own words — and reverses the audit repository's newest-first
order (TESTING.md: "that is what an operator asks for") because this view's
job is the story in the order it happened, not a log.

## 7. AI architecture

Use a provider interface:

```ts
interface ModelPort {
  interpretChange(input: InterpretChangeInput): Promise<InterpretedChange>;
  explainImpact(input: ExplainImpactInput): Promise<string>;
  rankCandidates(input: RankCandidatesInput): Promise<RankedCandidate[]>;
}
```

Production target: Bedrock adapter.  
Tests/local deterministic mode: fake adapter.

Do not couple domain types to a Bedrock response shape.

Structured AI output must be schema-validated before use.

The port's three operations are the only things a model is asked. Their
input and output shapes are contracts in `packages/contracts` (`model.ts`),
and `guardModelPort` in the application layer wraps any adapter so that every
answer is schema-validated and grounded before anything downstream sees it:

- an interpretation may name only IDs that were in the context it was given,
  so a confident answer about a made-up entity is refused as
  `UNGROUNDED_OUTPUT` rather than reaching intake;
- a ranking must be a permutation of the candidates it was given, with ranks
  1..n and a reason each; nothing added, nothing dropped;
- a malformed answer, a provider exception, and a missed time budget become
  `ModelError`s with a stable code and no prompt text.

Adapters therefore stay simple. The rule-based adapter, a local Ollama, and
Bedrock all sit behind the same guard, and the guarantee is tested once.

## 8. Change engine

The change engine is deterministic.

```text
Typed Change
   ↓
Dependency Resolver
   ↓
Impact Graph
   ↓
Candidate Generator
   ↓
Simulator
   ↓
Constraint Validator
   ↓
Proposal
```

The first MVP candidate generator can be simple and explicit rather than “smart”:

- find another shoot day where required cast/location are available;
- preserve scene requirements;
- return a small ordered set of valid candidates.

Optimization/constraint-solving can be added later.

`runChangeAgent` in the application layer is the loop: interpret, intake,
analyze, candidates, rank, simulate, explain, propose. Every step before
"propose" is a read or a record, and the proposal is a persisted plan awaiting
a human; no production state changes on any path. The model is asked three
things only: to read the sentence, to order candidates the engine already
validated, and to put findings into prose. The plan's shape is deterministic
code: the recorded fact first, then the remedy to the top-ranked day, then a
stale mark for every touched call sheet. When the model cannot rank or explain,
the agent falls back to date order and a data-only summary rather than
stopping.

The explanation layer (`explanation.ts` in the application package, TASK-306)
is what makes the data-only summary possible: `describeProposal` builds the
DESIGN.md §4 card (headline, `+`/`!` effects, operation lines) from the
snapshot, the operations, and the simulation findings, and `describeImpact`
builds the DESIGN.md §3 panel from an impact report. Both are pure functions
with contracts in `packages/contracts` (`explanation.ts`). The model's prose
is attached as an optional `narrative`; the rendered card is the proposal's
`summary`.

## 9. MongoDB

MongoDB stores operational state and audit records.

Recommended collections:

- productions
- scenes
- castMembers
- locations
- requirements
- shootDays
- callSheets
- tasks
- changeRequests
- proposals
- approvals
- auditEvents

Use indexes for common dependency queries, e.g.:

- `scenes.productionId`
- `scenes.requiredCastIds`
- `scenes.locationId`
- `shootDays.productionId + date`
- `proposals.productionId + status`
- `auditEvents.productionId + createdAt`

Do not over-denormalize initially. Prefer clear ownership and queryability for the prototype.

### Storage adapters

The application depends on repository ports, never on a driver. Three adapters
implement them:

| Adapter | Package | Role |
|---|---|---|
| JSON file | `@pca/file-store` | Runtime default. No server, no native module, no account. |
| In-memory | `@pca/memory-store` | Unit tests and throwaway demo runs. |
| MongoDB | `@pca/mongo-store` | The portfolio target. Requires a replica set so commits are transactional; refuses a standalone server. |

Every store is wrapped by `guardRepositories` in bootstrap (TASK-602): a
thrown driver error becomes an `InfrastructureError` that names the boundary
as `<adapter>.<repository>.<method>` and keeps the cause. Use cases let it
propagate; the queue retries it and records the boundary and correlation ID
as the reason; the MCP server reports `INTERNAL_ERROR` naming the boundary
without the driver's message.

One contract test suite in `@pca/test-support` runs unchanged against each of
them. An adapter that merely compiles against the ports has proved nothing;
when two adapters disagree, the disagreement must fail in that suite rather
than inside a use case that assumed one of them.

The file store is single-process: writes are serialised in-process, and two
processes writing the same file can still lose an update. Multi-writer
deployments select MongoDB. It reads through to the file on every call rather
than caching, so a second instance sees the first one's writes.

Entity rows in Mongo use a composite `_id` of `productionId::id`, so an entity
ID that repeats across productions is two rows rather than a collision, and
every read still filters by `productionId`. Audit rows keep Mongo's own
ObjectId, which increases with insertion order, so "newest first" stays correct
when two events share a timestamp.

Which adapter runs is decided in the composition root, `packages/bootstrap`,
from `PCA_STORAGE` (`file`, `memory`, or `mongo`) and its companions
(`PCA_DATA_FILE`, `PCA_MONGO_URI`, `PCA_MONGO_DB`). It is the one package that
depends on every adapter; the MCP server and the API ask it for a
`RepositorySet` and never name a driver.

The seed/reset command (TASK-801, `pnpm run seed`) is the one exception to
"never name a driver": `FileStore.resetProduction` clears every change
request, proposal, approval, audit event, and idempotency record belonging
to a production alongside replacing its state — `productions.save` alone
(the ordinary seed/reset path every adapter has) never touches those, so a
demo "restored" while still carrying a previous run's stale proposals and
audit trail would not be restored, just contaminated. No other adapter
needs this: the memory store is thrown away with the process, and Mongo is
the portfolio target, not the free runtime default this command exists
for. `resetDemoMovie` (`@pca/bootstrap`) wires `FileStore.resetProduction`
to the environment and refuses for any other `PCA_STORAGE`; `scripts/seed.ts`
is the one-command entry point, and the function it calls is what TASK-806's
future `seed` CLI subcommand will call too.

## 10. Queue/SQS

Use asynchronous jobs for operations that may involve model calls or larger analysis.

Example envelope:

```ts
type JobEnvelope = {
  id: string;
  type: "ANALYZE_CHANGE" | "APPLY_PROPOSAL" | "VERIFY_PROPOSAL";
  productionId: string;
  correlationId: string;
  attempt: number;
  payload: unknown;
};
```

Requirements:

- idempotency key;
- bounded retry;
- explicit failure state;
- dead-letter strategy in AWS;
- local in-memory/fake queue with identical application contract.

Implementation (TASK-401): `QueuePort` in the application layer fixes the
contract. An idempotency key names a job once (a repeat enqueue is a
`DUPLICATE`); retry is bounded by `QueuePolicy.maxAttempts` and exhausting it
is an explicit `FAILED` state plus a dead-letter entry; a handler answers
`COMPLETED`, `RETRY`, or `FAILED`, and an exception it throws is retried as
transient; every state change is observable through `onTransition`, which is
what the job state machine and the WebSocket gateway consume. Timers go
through a `Scheduler` port so tests can hold time still. `@pca/memory-queue`
is the free default (`PCA_QUEUE=memory`), single-process, delivering one job
at a time in enqueue order; `drain()` is its deterministic path and
`start()`/`stop()` its background one. The SQS adapter (TASK-402) is deferred
and would run the same contract suite.

## 11. Realtime/WebSocket

WebSocket publishes job state and user-visible events.

Do not make WebSocket the source of truth. The client can reconnect and fetch canonical job/proposal state via REST.

Implementation (TASK-403): the job stage machine in `packages/application/src/jobs/`
is pure. `JOB_STAGE_TRANSITIONS` is the only way a run moves, and it has no
edge into `applying` except from `awaiting_approval` and no edge out of
`completed` or `failed`; a disallowed move throws `JobStageError`. A `JobRun`
(`jobRunSchema`) is the canonical record: current stage, its status, a
message, the linked change request and proposal, and every event ever
published for it. `JobTracker` applies the machine, persists the run through
the `JobRunRepository` port, and publishes `AgentJobEvent`s, so an event
exists only if the record also holds it. Each move publishes the stage left
as `COMPLETED` (or `FAILED`) and the stage entered as `STARTED`.

Queue handlers drive the machine. The analyze handler walks `received →
resolving → analyzing → simulating → validating → awaiting_approval`, using
`runChangeAgent`'s `progress` hook; an ambiguous sentence leaves the run at
`resolving` with the question as its message until a resolved change arrives;
nothing to propose completes from `analyzing`; an invalid proposal fails at
`validating`. The apply handler walks `awaiting_approval → applying →
verifying → completed` and reads the run's stage before acting, so a job
redelivered after a crash mid-verification verifies without applying again.
A use-case error fails the run and the queue job (no retry); an exception
propagates and the queue retries. `bindQueueToJobTracker` announces retries on
the current stage and fails the run when the queue gives up.

The gateway (TASK-404, `@pca/ws-gateway`, built on `ws`) is a notification
channel only. The application publishes `RealtimeNotification`s to an
in-process `NotificationHub`: job events are forwarded from the tracker
(`forwardJobEvents`), and proposal status comes from
`withProposalNotifications`, a decorator on the proposal repository that
publishes after every successful save, which is the one place every status
change passes through. The gateway subscribes to the hub and forwards each
notification to the connections that subscribed to that production. It
holds no history and replays nothing; its first message on every connection
(`welcome`) names REST as the canonical source, and a reconnecting client
re-reads job runs and proposals (TASK-405). Clients name productions
explicitly; an `authorize` hook can refuse one, subscriptions per connection
are capped, malformed messages get an `error` reply rather than a
disconnect, and a heartbeat drops sockets that stop answering. The gateway
attaches to the API's HTTP server on a path or listens on its own.

Recovery (TASK-405) is a read plus an ordering rule. The read is
`createGetRecoverySnapshot`: the production version, every job run (newest
first), and every proposal still open (`DRAFT`, `AWAITING_APPROVAL`,
`APPROVED`); `createGetJobRun` reads one run, visible only through its own
production. The REST API serves both (TASK-110). The ordering rule lives in
`@pca/realtime-client`, which runs unchanged in a browser or under Node: on
every connection, first or re-established, it subscribes to each production
it follows, waits for the server's `subscribed` acknowledgement, and only
then reads the snapshot. Anything that happens after the acknowledgement
arrives live; the snapshot, read after it, covers everything before, so no
event can fall between them. Live notifications are merged into the
recovered records; one that arrives while a recovery is in flight is held
and applied after the snapshot; one about a job or proposal the client does
not know triggers another recovery rather than a guess; one the record
already reflects is ignored. Reconnection backs off exponentially through an
injected timer, and a socket that closes mid-recovery discards what it held,
because the next recovery is the truth.

Suggested event:

```ts
type AgentJobEvent = {
  jobId: string;
  productionId: string;
  stage: string;
  status: "STARTED" | "COMPLETED" | "FAILED";
  message?: string;
  occurredAt: string;
};
```

## 12. OpenSearch

OpenSearch is **optional for initial MVP**.

Good later use:

- production-document RAG;
- searching notes/scripts/production documents;
- demonstrating migration of existing hybrid-search experience.

Do not use OpenSearch to solve deterministic entity relationships already represented in MongoDB.

## 13. MCP placement

MCP is the controlled agent interface, not the domain itself.

```text
Agent
  ↓
MCP tool
  ↓
Schema validation
  ↓
Authorization / approval checks
  ↓
Application use case
  ↓
Domain
  ↓
Repository
```

## 14. Infrastructure

Terraform target modules/resources:

- IAM roles/policies
- SQS queue + DLQ
- optional OpenSearch
- application runtime chosen during implementation
- logging/monitoring primitives

Avoid deploying expensive resources merely for portfolio completeness. Infrastructure can be validated with Terraform checks and documented plans before live deployment.

## 15. Security

- least-privilege AWS IAM;
- secrets only through environment/secret management;
- schema validation at every external boundary;
- authorization server-side;
- approval enforcement server-side;
- prompt/tool inputs treated as untrusted;
- no hidden chain-of-thought logging;
- audit structured actions/results instead.

## 16. Observability

Use correlation IDs across:

- HTTP request;
- agent job;
- MCP call;
- proposal;
- queue message.

Capture latency for:

- model calls;
- MCP tools;
- dependency analysis;
- database operations.

This creates a natural performance-debugging story similar to real production engineering.

## 17. Architecture rule of thumb

If the AI provider, MongoDB, AWS, or MCP transport were replaced tomorrow, the core change-analysis tests should still pass unchanged.
