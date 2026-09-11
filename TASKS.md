# Implementation Backlog

This backlog is designed for bounded agent execution and parallel work.

Execution order under the free-tier constraint (no paid service, no AWS account): `docs/WORK_PLAN.md`.
Tasks marked **DEFERRED (paid)** are not executed until a budget/AWS account exists; only the free portion noted in each task is in scope.

## Task format

Every implementation task should contain:

```text
Goal
Context
Dependencies
Allowed scope
Acceptance criteria
Tests
Definition of Done
```

Agents should not silently expand scope.

---

# P0 — Repository Foundation

## TASK-001 Monorepo foundation — DONE

**Status**  
Complete. pnpm workspaces, strict TypeScript, ESLint with the framework-independence boundary rule, Prettier, three Vitest suites, and a `verify` gate that reports per-step results. Commands are documented in `README.md` "Local development".

**Goal**  
Create the TypeScript monorepo structure and root verification commands.

**Dependencies**  
None.

**Scope**

- root package/workspace configuration
- `apps/`
- `packages/`
- strict TS configs
- lint/test tooling

**Acceptance**

- clean install works;
- `npm run typecheck` works;
- `npm run lint` works;
- `npm run test` works;
- empty/smoke `npm run verify` works.

**Tests**
Tooling smoke tests.

**Done**
Commands documented and green.

## TASK-002 Shared contracts — DONE

**Status**  
Complete. `packages/contracts` holds zod schemas and inferred types for primitives, entities, change requests, impacts, proposals, approvals, audit events, jobs, errors, and all seventeen MCP tools, with a `MCP_TOOL_CONTRACTS` registry. 94 unit tests cover valid and invalid cases.

**Goal**  
Implement typed/schema-validated external contracts.

**Dependencies**  
TASK-001.

**Scope**
`packages/contracts`.

**Acceptance**
Schemas exist for ChangeRequest, Impact, Proposal, Approval, MCP inputs/outputs, job events.

**Tests**
Valid/invalid schema cases.

## TASK-003 Domain model — DONE

**Status**  
Complete. `packages/domain` implements the production snapshot and index, calendar helpers, requirement identity, proposal digests, natural idempotency, and INV-1 through INV-8 as pure functions. 189 unit tests pass, including a structural test that fails if the domain imports anything outside an allow-list.

**Goal**  
Implement entities and invariants from `DOMAIN.md`.

**Dependencies**  
TASK-001, TASK-002.

**Scope**
`packages/domain`.

**Acceptance**
No infrastructure imports; invariants executable.

**Tests**
INV-1 through INV-8 where applicable.

## TASK-004 Demo Movie fixtures — DONE

**Status**  
Complete. `packages/fixtures` publishes `DEMO_MOVIE_IDS` and `createDemoMovie()`; `packages/test-support` gains scenario helpers for introducing a conflict. The integrity test asserts the ID set, schema validity, domain invariants, each TESTING.md §3 precondition separately, and that each golden scenario's conflict lands on exactly the expected scenes. IDs are documented in `TESTING.md` §3.

**Goal**  
Create deterministic fixture/builders.

**Dependencies**  
TASK-003.

**Scope**
`packages/fixtures`, `packages/test-support`.

**Acceptance**
Stable IDs and golden scenario preconditions.

**Tests**
Fixture integrity test.

---

# P1 — Persistence and Application Core

## TASK-101 Repository ports + free default adapters — DONE

**Status**  
Complete. `packages/application` defines the six repository ports and the shared production-isolation guard. `@pca/memory-store` and `@pca/file-store` implement them, and one contract suite in `@pca/test-support` runs unchanged against both: 34 cases per adapter. `PCA_STORAGE` selection moves to the composition root in TASK-110, since no package below it may know more than one adapter exists.

**Goal**  
Define repository interfaces required by application use cases and ship the two zero-install adapters.

**Dependencies**  
TASK-003, TASK-004.

**Scope**

- repository ports in `packages/application`
- in-memory adapter (`packages/adapters/memory-store`) for unit tests and demo runs
- JSON file adapter (`packages/adapters/file-store`) as the default runtime store for the npm distribution: single file under a user data directory, atomic write (temp file + rename), production `version` preserved for stale-proposal detection
- runtime selection via `PCA_STORAGE=file|memory|mongo`, wired in the composition root (TASK-110); Mongo lands in TASK-102

**Acceptance**

- one shared repository contract test suite runs unchanged against in-memory, file, and (later) Mongo adapters;
- production isolation (INV-4) enforced in every adapter;
- the file adapter needs no native module and no external server.

**Why a file store**  
See `ARCHITECTURE.md` §2 "Free-first constraint". The published package must run on a clean machine with `npx` alone.

## TASK-102 MongoDB adapters — DONE

Implement MongoDB repositories and indexes.

**Acceptance**
Adapters satisfy repository contracts and production isolation.

**Status**  
Complete. `@pca/mongo-store` implements every port with the documented collections and indexes; `commit` is a multi-document transaction guarded by a version-filtered update, and a standalone server is refused at connect time. The repository contract suite and the golden scenario suite both pass against it via `mongodb-memory-server` in replica-set mode, with no server installed. `PCA_MONGO_URI` selects the server; wiring into `PCA_STORAGE` lands in TASK-110.

## TASK-103 Change intake use case — DONE

Persist raw/typed change request and correlation ID.

**Status**  
Complete. `submitChangeRequest` in `packages/application` validates the typed change, confirms every referenced ID against the production, persists the request with the raw sentence and a correlation ID, and appends one audit event. `Clock` and `IdFactory` ports make the written records exactly assertable. 15 unit tests.

## TASK-104 Dependency impact engine — DONE

Implement deterministic impact traversal.

**Acceptance**
Golden scenario impact sets are exact.

**Status**  
Complete. `analyzeImpact` in `packages/domain/src/impact` walks all four change types and returns impacts, conflicts, and affected IDs in canonical order. GOLDEN-1/2/3 are asserted as exact arrays against the Demo Movie, with the WHY text pinned. `analyzeChangeImpact` in `packages/application` wraps it as a read that returns the production version alongside. Reason codes are tabulated in `DOMAIN.md` §5.

## TASK-105 Candidate schedule generator — DONE

Implement simple valid-day candidate generation.

**Non-goal**
Do not build a general optimization solver.

**Status**  
Complete. `generateScheduleCandidates` in `packages/domain` returns existing shoot days on which every moving scene's cast and location are free, earliest first, with warnings, plus every refused day and its reasons. No scoring, capacity, splitting, or new days. The use case in `packages/application` wraps it as a read. Output contract gains `rejected` (MCP.md §5).

## TASK-106 Proposal simulation/validation — DONE

Create side-effect-free simulation and proposal validation.

**Status**  
Complete. `applyOperations` in `packages/domain` applies operations atomically to a copy of the snapshot with an injected ID allocator, so simulation (placeholder IDs) and the coming apply path (real IDs) share one implementation. `simulateProposal` judges the copy by the state invariants and reports impacts, conflicts, resolved conflicts, warnings, and a summary. `validateProposal` in `packages/application` re-judges a stored proposal against the current production, detects stale versions and tampered digests, and writes the refreshed verdict back onto the proposal. Contract gains `resolvedConflicts` and `warnings` on `simulate_proposal`.

## TASK-107 Approval model — DONE

Implement proposal digest, approval binding, stale-version checks.

**Status**  
Complete. `createProposal` seals operations into a persisted proposal with its simulation verdict and digest (invalid ones become a `DRAFT` that shows why). `decideProposal` writes the approval record bound to digest and base version, re-simulating once more before approving; rejection is always allowed; a decision is final. Both audit. A test proves the record satisfies the domain's `checkWriteAllowed` gate. 18 tests.

**Decision surfaced and settled in TASK-108**  
Unavailability is now recorded on the entity by two dedicated operations; see `docs/WORK_PLAN.md` §6.

## TASK-108 Apply proposal — DONE

Implement high-level approved proposal execution with idempotency and version increment.

**Status**  
Complete. `applyApprovedProposal` runs the fixed check order (idempotency, then the INV-5/INV-6 gate, then apply to a copy, then atomic commit, then bookkeeping) and writes only the records that changed. The operation allow-list gained `RECORD_CAST_UNAVAILABILITY` and `RECORD_LOCATION_UNAVAILABILITY` by the user's decision, so an applied availability change is remembered by the production. GOLDEN-1 and GOLDEN-3 run end to end through intake, proposal, approval, and apply.

## TASK-109 Verification — DONE

Implement post-write verification checks.

**Status**  
Complete. `verifyOperationsApplied`, `verifyAvailabilityHonoured`, and `verifyInvariantsHold` in `packages/domain` observe stored state operation by operation. `verifyAppliedProposal` in `packages/application` adds the version, status, and apply-audit checks that catch a write whose bookkeeping did not land, returns the full named list, and audits the outcome. With this, P1 is complete: intake through verification runs end to end on the Demo Movie.

## TASK-110 REST API — DONE

**Status**  
Complete. `apps/api` (Express 5) under `/api/productions/:productionId`: reads (production, scene, cast and location search, availability, schedule, call sheet, tasks), analysis, candidates, simulations, proposals (create, get, list by status, validation, verification), change requests (synchronous intake and read), a human's `decision`, `apply` (synchronous, or as a job when `jobId` is given), `changes` (asynchronous job; resume at `resolving` with `jobId` and the chosen change), jobs (list, get), `recovery`, and `audit`; plus `/api/health`. The WebSocket gateway is attached to the same server on `/ws`. Reads, analysis, proposal, apply, and verify routes run the MCP tool handlers, so both surfaces validate the same contracts; errors are the same `ToolError` with a status derived from the code. Authorization is the server-side production allow-list; the actor comes from `X-Actor-Id`; `X-Correlation-Id` is honoured and echoed. Entry point `apps/api/src/main.ts` (`PCA_API_PORT`, `PCA_API_HOST`). 12 API tests run in the contract suite.

**Goal**  
Expose application use cases over HTTP in `apps/api` (Express).

**Dependencies**  
TASK-103 through TASK-109.

**Scope**

- routes: production, change requests, proposals, approvals, audit events, job status
- request/response schemas from `packages/contracts`
- server-side authorization and production context
- correlation ID propagation

**Acceptance**

- Angular UI and E2E tests can drive the three golden scenarios through REST alone;
- approval enforcement lives in the application layer, not in routes;
- invalid schema, cross-production ID, and missing approval return stable error codes.

**Tests**
API tests for each route including auth/context boundaries (`TESTING.md` §2 "API tests").

---

# P2 — MCP

## TASK-201 MCP server foundation — DONE

Register server, schemas, context, logging.

**Status**  
Complete. `apps/mcp-server` registers tools from `MCP_TOOL_CONTRACTS` with JSON Schema generated from the contracts, validates input and output with the strict contract schemas, authorises every call against a server-side context from the environment, maps use-case failures and crashes to structured `ToolError` results, and logs JSON lines to stderr. The foundation is exercised through a real MCP client over an in-memory transport in the contract suite. `packages/bootstrap` was added as the composition root (`PCA_STORAGE` selection), which TASK-110 will reuse rather than duplicate.

## TASK-202 Read tools — DONE

**Status**  
Complete. All nine handlers in `apps/mcp-server/src/handlers/read-tools.ts`, wired into the server entry point. Contract tests cover, per tool, valid input, malformed input, an unknown production, a missing entity, and determinism, through a real MCP client.

Implement:

- get_production
- get_scene
- find_cast
- get_cast_availability
- find_location
- get_location_availability
- get_schedule
- get_call_sheet
- get_tasks

## TASK-203 Analysis tools — DONE

**Status**  
Complete. Four thin handlers in `apps/mcp-server/src/handlers/analysis-tools.ts` over the existing use cases, wired into the entry point. `validate_proposal` strips the refreshed proposal from its answer because the output contract does not include it. Contract tests cover advertisement, refusals, the documented answers, and that none of them writes production state.

Implement:

- analyze_change_impact
- generate_schedule_candidates
- simulate_proposal
- validate_proposal

## TASK-204 Proposal tools — DONE

Implement create/get proposal.

**Status**  
Complete. `create_proposal` records the server context's acting identity as the proposer; `get_proposal` is a plain read of the stored record. Both wired into the entry point with the system clock and random ID factory. Contract tests cover advertisement, refusals, sealing with the actor audited, an invalid draft, and round-tripping.

## TASK-205 Safe write tool — DONE

Implement `apply_approved_proposal`.

**Critical acceptance**
No approval = no mutation.

**Status**  
Complete. A thin handler over the apply use case, recording the server context's acting identity as who performed the apply. There is no approve tool; the contract tests create approvals through the use case. Every refusal test proves the production did not change: no approval, a wrong approval, an invalid proposal, a stale expected version, an edited proposal, a reused idempotency key, a production outside the allow-list, a missing binding field, and smuggled operations.

## TASK-206 Verification tool — DONE

Implement `verify_applied_proposal`.

**Status**  
Complete. A thin handler over the verification use case, returning only `success` and the named `checks` as the contract specifies. With this, all seventeen tools in `MCP_TOOL_CONTRACTS` are wired into the server entry point. Contract tests cover the full pass after GOLDEN-1, the bookkeeping gap named as a single failed check, an un-applied proposal reported honestly, no production change, and the refusals.

## TASK-207 MCP contract suite — DONE

Test all success/error/security cases in `MCP.md`.

**Status**  
Complete. Per-tool suites (TASK-202 to TASK-206) pin each tool's answers; the registry-wide suite walks `MCP_TOOL_CONTRACTS` and holds every tool to the same contract against `createAllToolHandlers`, the exact handler set the entry point ships. TASK-603 is delivered in the same suite.

---

# P3 — AI Orchestration

## TASK-301 Model port — DONE

Define provider-independent model interface.

**Status**  
Complete. `ModelPort` in `packages/application` with three operations; input and output schemas in `packages/contracts/src/model.ts`; `guardModelPort` wraps any adapter to schema-validate and ground every answer (no invented IDs, rankings are permutations), wrap provider faults, and enforce a time budget, raising `ModelError` with a stable code. 24 guard tests and 7 schema tests.

## TASK-302 Fake model adapter + rule-based interpreter adapter — DONE

**Status**  
Complete. `@pca/rule-model` is the runtime default: it interprets the SPEC.md §5 sentence shapes and close variants deterministically, returns ambiguity as options and unknown shapes as `UNSUPPORTED` with a reason, explains from findings, and ranks by fewest warnings then earliest date. `createFakeModelAdapter` in test-support answers the golden sentences and can misbehave in each way a provider might; the guard catches all four. `PCA_MODEL` selection lives in bootstrap, every model behind the guard. The Ollama adapter remains an optional later step.

**Goal**  
Provide two free `ModelPort` implementations with distinct roles.

**Scope**

- `FakeModelAdapter`: deterministic canned outputs keyed by known inputs. Test-only. Also produces the malformed cases from `TESTING.md` §5.
- `RuleInterpreterAdapter`: deterministic parser for the sentence patterns in `SPEC.md` §5 (cast unavailable, location unavailable, scene requirement changed) and their close variants. Default runtime model for the npm distribution.
- optional `OllamaAdapter`: used automatically when a local Ollama endpoint is reachable, for free-form sentences beyond the rule patterns.
- runtime selection via `PCA_MODEL=rules|ollama|bedrock|fake`.

**Acceptance**

- all three golden scenarios pass with `PCA_MODEL=rules` and no network;
- rule adapter output is schema-validated like any other model output;
- unknown sentence shapes return `ENTITY_AMBIGUOUS`/`UNSUPPORTED_CHANGE` with a next-step hint instead of guessing.

## TASK-303 Bedrock adapter — DEFERRED (paid)

Implement structured-output model calls behind the port.

**Free scope**  
Code plus unit tests against a mocked Bedrock SDK client only. No live calls. `FakeModelAdapter` (TASK-302) is the executed path; an optional local Ollama adapter may be added behind `ModelPort` for demos.

**Acceptance**
No Bedrock dependency leaks into domain/application packages.

## TASK-304 Change interpreter — DONE

Natural language → schema-validated typed change candidate → entity resolution.

**Status**  
Complete. `interpretChange` in `packages/application` builds the interpretation context from the snapshot (names, scene numbers, shoot days, today in the production's timezone), calls the model behind the guard, and checks every returned ID against the production once more. Resolved changes, ambiguity as options, and unsupported sentences each have a documented outcome; a misbehaving model yields a retry or rephrase hint, never a fabricated change.

## TASK-305 Agent orchestration — DONE

**Status**  
Complete. `runChangeAgent` in `packages/application` runs interpret, intake, analyze, candidates, rank, simulate, explain, propose. Outcomes: `PROPOSED`, `NEEDS_RESOLUTION` (before anything is recorded), `NO_CANDIDATE`, `NOTHING_TO_DO`. The plan shape matches the golden suite; the model's failures fall back to data. A test proves no production state changes on any path.

Implement:

```text
interpret
→ read
→ analyze
→ candidate generation
→ simulate
→ validate
→ explain
→ proposal
```

No write occurs here before approval.

## TASK-306 Explanation layer — DONE

**Status**  
Complete. `describeProposal` / `renderProposalExplanation` / `toProposalSummary` and `describeImpact` / `renderImpactExplanation` in `packages/application/src/explanation.ts`, with contracts `proposalExplanationSchema` and `impactExplanationSchema`. The agent's proposal `summary` is now the rendered DESIGN.md §4 card; the model's prose is an optional narrative. 20 tests pin the golden cards exactly.

Produce concise user-facing explanation from structured deterministic results.

---

# P4 — Async / Realtime

## TASK-401 Queue port + fake queue — DONE

**Status**  
Complete. `QueuePort` (with `Scheduler`, `QueuePolicy`, `JobRecord`, `JobTransition`, `JobHandlerOutcome`) in `packages/application/src/ports/queue.ts`; `@pca/memory-queue` is the free runtime adapter and the test double in one. Idempotent enqueue (`DUPLICATE`), bounded retry with backoff through an injected scheduler, explicit `FAILED` plus a dead-letter list when attempts run out, thrown handler errors retried as transient, duplicate deliveries of finished jobs ignored. The queue contract suite in `@pca/test-support` (`describeQueueContract`) is what an SQS adapter would also run. Bootstrap reads `PCA_QUEUE` (`memory` default, `sqs` deferred).

Deterministic local queue.

## TASK-402 SQS adapter — DEFERRED (paid)

Implement enqueue/consume/retry/DLQ-oriented behavior.

**Free scope**  
None executed. The in-memory queue (TASK-401) is the only queue adapter until an AWS account exists.

## TASK-403 Job state machine — DONE

**Status**  
Complete. `packages/application/src/jobs/`: a pure stage machine (`JOB_STAGE_TRANSITIONS`, `advanceJobRun`, `failJobRun`, `noteJobRun`; a disallowed move throws `JobStageError`, and `applying` is reachable only from `awaiting_approval`), a `JobTracker` that persists `JobRun` records and publishes `AgentJobEvent`s, queue handlers for `ANALYZE_CHANGE` / `APPLY_PROPOSAL` / `VERIFY_PROPOSAL` that read the run's stage before acting (so redelivery never applies twice), and `bindQueueToJobTracker` for retries and queue-level failures. `runChangeAgent` reports `analyzing` / `simulating` / `validating` through a `progress` hook. Contracts: `jobRunSchema` and the three payload schemas. Job runs live in `@pca/memory-queue` beside the queue.

Implement documented job stages.

## TASK-404 WebSocket gateway — DONE

**Status**  
Complete. `@pca/ws-gateway` (`ws`) forwards notifications from the application's `NotificationHub` to clients subscribed per production; it holds no history and replays nothing, and its `welcome` message names REST as the canonical source. Sources: `forwardJobEvents` (tracker → hub) and `withProposalNotifications` (a repository decorator that notifies after every proposal save, so creation, validation, decision, apply, and failure all publish). Contracts in `realtime.ts`: client messages `subscribe` / `unsubscribe` / `ping`, server messages `welcome` / `subscribed` / `unsubscribed` / `job` / `proposal` / `pong` / `error`. Malformed messages get an error, not a disconnect; an `authorize` hook can refuse a production; subscriptions per connection are capped; a heartbeat drops dead sockets. Attaches to an existing HTTP server (`attach`) or listens alone (`listen`).

Publish job/proposal status.

## TASK-405 Reconnect/recovery — DONE

**Status**  
Complete. Recovery queries in the application layer: `createGetRecoverySnapshot` (production version, every job run newest first, open proposals `DRAFT` / `AWAITING_APPROVAL` / `APPROVED`) and `createGetJobRun` (visible only through its own production); contract `recoverySnapshotSchema`. `@pca/realtime-client` is the framework-independent reconnecting client: on every connection it subscribes to the productions it follows, waits for each `subscribed` acknowledgement, and only then reads the snapshot, which closes the gap between snapshot and subscription. Live notifications apply on top; ones that arrive during a recovery are held and applied after it; a notification about an unknown job or proposal triggers another recovery; a notification the record already reflects is ignored. Reconnects with exponential backoff through an injected timer. The REST routes that serve the snapshot are TASK-110.

Client can recover canonical state after socket loss.

---

# P5 — Angular UI

## TASK-501 Angular shell — DONE

**Status**  
Complete. `apps/web` (Angular 21, zoneless, signals, standalone components): the DESIGN.md §2 shell with the production header (name, connection status as a word, version, jobs in progress), the production nav (Change Workspace, Overview, Scenes, Cast, Locations, Schedule, Call Sheets, Tasks, Audit), and the routed area. The change workspace is a frame whose panels state which task fills them (502-506) rather than showing a fake answer. Overview and Audit read from REST. Connection points: `ProductionApi` (typed by the shared contracts, errors as `ApiError` carrying the server's `ToolError`) and `RealtimeService` (wraps `@pca/realtime-client` in signals; recovery goes through REST). `ProductionStore` owns the open production and its version. Dev server proxies `/api` and `/ws` to the API. `ng build` (AOT, strict templates) runs in the verify `build` step and the specs (vitest 4 + jsdom via `ng test`) in the new `test:web` step. The root TypeScript project excludes `apps/web`, which type-checks itself with the DOM lib. Angular 22 was not used because it requires TypeScript 6.

Production navigation + change workspace.

## TASK-502 Change input/resolution — DONE

**Status**  
Complete. `apps/web/src/app/workspace/`: `ChangeInput` submits a sentence as a job (`POST .../changes`) with the golden-scenario sentences as clickable examples; `ChangeSubmissionService` (component-scoped, one per workspace) tracks the submitted job, resuming it (`jobId` + the chosen change) when the user resolves an ambiguity, and refreshes it over REST on every live event for it rather than trusting the event's own content; `AmbiguityResolution` renders a `resolving` run's question and options, each option showing the resolved change so two entries sharing a label (two cast members named "Sarah") stay distinguishable; `DetectedChangeCard` renders the persisted `ChangeRequest` once known, via the pure formatter `typed-change-format.ts`. `JobRun` gained an `options` field (`jobRunSchema`, TASK-403's contract) carrying the interpretations while `stage === "resolving"`; `AgentJobEvent` does not carry it on purpose, matching "the socket is a hint, the record is the truth" (ARCHITECTURE.md §11). Confidence and a pre-analysis edit step are documented gaps (DESIGN.md §3), not implemented: confidence is not persisted past interpretation, and `runChangeAgent` (TASK-305) has no pause point between interpret and propose. 31 new Angular tests (formatter, service, 3 component specs, 2 more on the REST client) plus contract/application coverage for the new `options` field; `pnpm verify` passes.

Input, ambiguity resolution, detected-change card.

## TASK-503 Impact view — DONE

**Status**  
Complete. `analyzeChangeImpact` now computes the DESIGN.md §3 impact panel alongside the raw impacts/conflicts, via `describeImpact` (`explanation: ImpactExplanation`). The MCP `analyze_change_impact` tool narrows the result to the original four fields — the strict output schema has no room for it, matching the `validate_proposal` precedent — so the REST API exposes it on a dedicated route, `POST .../productions/:id/analysis/explanation`, one of TASK-110's documented REST-only exceptions. `apps/web/src/app/workspace/`: `ProductionApi.getImpactExplanation`; `ChangeSubmissionService` fetches it once the tracked job's change request is known (chained after `loadChangeRequestIfKnown`, guarded the same way); `ImpactPanel` is a pure presentational component rendering BLOCKING, the six AFFECTED groups in the server's exact order (empty ones omitted), and WHY. 9 new tests (1 application, 3 API contract, 5 Angular incl. an extended service cascade test) plus a regression guard added to an existing MCP contract test proving the field does not leak; `pnpm verify` passes.

Grouped impacts with deterministic `why`.

## TASK-504 Proposal view — DONE

**Status**  
Complete. `runChangeAgent` already built the DESIGN.md §4 structured proposal card at proposal-creation time; rather than recomputing it against production state that may have moved on, the ANALYZE_CHANGE job handler carries it — and, for a scheduling change, the ranked/rejected shoot days the candidate generator considered — onto the tracked `JobRun` (`explanation: ProposalExplanation`, `candidateComparison: CandidateComparison`), the same mechanism `options` already uses for ambiguity (TASK-502/403). No new REST route: both arrive with the job `ChangeSubmissionService` already reads. `apps/web/src/app/workspace/`: `ProposalCard` (headline, `+`/`!` effects, operations, optional narrative) and `CandidateComparisonPanel` (ranked list with the top rank marked chosen, warnings, rejected days with reasons) — both pure presentational components, wired into the "What do you recommend?" panel. 9 new tests (2 application, 1 contract, 6 Angular); `pnpm verify` passes.

Operations, warnings, candidate comparison.

## TASK-505 Approval flow — DONE

**Status**  
Complete. `ChangeWorkspace`'s Reject and Approve & Apply buttons enable only while the tracked job is `awaiting_approval`. `ChangeSubmissionService.reject` decides `REJECT` with the job's ID (the decision route then completes that job server-side, `awaiting_approval → completed` — an edge `JOB_STAGE_TRANSITIONS` already named but nothing called before this task, added best-effort and idempotently) and re-reads the job immediately. `approveAndApply` decides `APPROVE`, then applies as a job continuing the run's timeline, using `expectedProductionVersion` from the decision's own response (the version the proposal was actually built against). `ApprovalConfirmation` gates Approve & Apply with DESIGN.md §5's final confirmation: proposal summary, operation count, warnings (the explanation's `ATTENTION` effects), current production version, and the fixed notice that the plan will change; the backend still enforces validity either way. 22 new tests (1 API contract for the reject-completes-the-job route, 21 Angular incl. the workspace's own wiring spec); `pnpm verify` passes.

Reject / Approve & Apply with explicit confirmation.

## TASK-506 Realtime progress — DONE

Render job stages.

**Status**  
Complete. The workspace's "Progress" panel, previously a raw list of `ProductionStore.openJobs`, now renders DESIGN.md §6's compact ✓/●/○ timeline for the one job the workspace is tracking (`ChangeSubmissionService.job`, the same job every other panel reads). `buildJobProgress` (`apps/web/src/app/workspace/job-progress-format.ts`) is a pure function of the job's `history`: a stage is `done` once its own `COMPLETED` event exists, `active` while it is the run's current stage, `pending` otherwise — including a stage the run's actual path skipped (an already-resolved change never visits `resolving`; a `NOTHING_TO_DO`/rejection path never visits `applying`/`verifying`), which stays `pending` rather than `done`. A `failed` run returns only the failed stage and its message, not the full list. `JobProgressTimeline` renders the result with no logic of its own; each row carries a distinct icon plus bold text for the active row, so status is never color-only. 10 new Angular tests (6 for `buildJobProgress`, 3 for `JobProgressTimeline`'s render, 1 confirming `ChangeWorkspace` wires the tracked job through); `pnpm verify` passes.

## TASK-507 Schedule view — DONE

Show before/after state clearly.

**Status**  
Complete. Neither this nor TASK-508 needed new backend surface — `get_schedule`/`get_scene` and the `/audit` route (TASK-110) already existed — so both were pure Angular polish on the two nav views TASK-501 had left as placeholders, done together as one WORK_PLAN step. The Schedule nav entry (`SchedulePage`) resolves every scene ID a shoot day names through `get_scene` (a scene ID is opaque, never assumed to encode anything) and renders `buildScheduleRows`'s result, one shoot day per section, earliest first, each scene labelled by number, title, location, and required cast. "Before/after" is simply always showing the schedule the server currently has: approve a change and come back here, and the "after" is whatever changed — no separate diff endpoint to keep in sync with production state that may have moved on again. The other five production-nav placeholders (Scenes, Cast, Locations, Call Sheets, Tasks) stay `SectionPage` stubs; no task ever scoped views for them.

## TASK-508 Audit view — DONE

Structured action timeline without chain-of-thought.

**Status**  
Complete, alongside TASK-507. `describeAuditEvent` (`apps/web`) turns every action the audit-writing use cases actually emit (`CHANGE_REQUEST_SUBMITTED` through `PROPOSAL_VERIFICATION_FAILED`) into one DESIGN.md §7 sentence, reading only `action` and structured `metadata` — never a model's own words, so nothing here can be chain-of-thought; an action outside that vocabulary still renders a humanized, non-blank line rather than nothing. `AuditPage` fetches through the existing `listAudit` route (newest first, the right order for "what just happened") and reverses it, because this view's job is the story in the order it happened. Each line's time is formatted in the production's own timezone. 27 new tests (2 `ProductionApi`, 6 `schedule-format`, 2 `SchedulePage`, 15 `audit-format`, 2 `AuditPage`); `pnpm verify` passes.

---

# P6 — Testing / CI

## TASK-601 Golden scenario tests — DONE

Implement GOLDEN-1/2/3.

**Status**  
Complete, pulled forward from P6 as the regression baseline for everything after P1. `describeGoldenScenarios` in `packages/test-support` runs the full pipeline (intake, analysis, candidates, simulation, proposal, refused apply, approval, apply, replay, re-simulation, verification) once per scenario and asserts every TESTING.md §4 bullet by name, on both the memory store and the file store.

## TASK-602 Failure injection — DONE

**Status**  
Complete. `packages/application/test/failure-injection.test.ts` is the one place for every failure in TESTING.md §8: repository failure (direct and through the queue, where the second attempt applies exactly once), stale production version (simulate, create, apply), approval mismatch (wrong approval; edited proposal), queue retry exhaustion with dead letter, partial operation failure (refused whole, nothing committed, proposal `FAILED`, audited), verification failure (named check, audited), and model provider failure (hang, ungrounded). Each case asserts the outcome, that nothing was written, and that the message names the failing boundary and the correlation ID. Infrastructure: `InfrastructureError` + `guardPort` / `guardRepositories` name a thrown fault `<adapter>.<repository>.<method>`; bootstrap guards every store; the queue's retry reason and the MCP `INTERNAL_ERROR` carry boundary and correlation ID. `withFault` / `withRepositoryFault` in `@pca/test-support` script faults. A Mongo failure integration test closes the client and asserts the named boundary. WebSocket disconnect/reconnect is covered by TASK-405's suites.

Implement stale version, provider failure, queue retry, partial failure cases.

## TASK-603 Security tests — DONE

Implement approval/cross-production/schema/tool-boundary tests.

**Status**  
Complete, pulled forward from P6 into the registry-wide suite: arbitrary tool and operation names, a tampered digest on validate and apply, a stale approval, prompt-shaped input, and a wide-open allow-list that still never echoes another production's data. Every refusal proves nothing changed.

## TASK-604 Playwright E2E — DONE

Three core scenarios.

**Status**  
Complete. Three Playwright specs (`e2e/golden-{1,2,3}-*.spec.ts`), one per golden scenario, drive a real Chromium against the real stack: `playwright.config.ts`'s `webServer` starts `apps/api/e2e/server.ts` (the same composition `main.ts` uses — `createRuleModelAdapter`, the in-process queue, a memory store — seeded with three independent copies of the Demo Movie fixture, `PROD-E2E-1/2/3`, so the three specs can run in parallel without one's mutation breaking another's preconditions) and `ng serve`. Each spec follows DESIGN.md §10's demo story: submit the golden sentence, read the impact/proposal panels, approve through the §5 confirmation, wait for the §6 progress timeline to finish, check the Schedule and Audit nav views. Two real things this surfaced along the way: `ng serve`'s Vite dependency pre-bundler cannot resolve the workspace packages' extensionless relative imports (fixed with `prebundle: false` in `angular.json`, ARCHITECTURE.md), and the real rule model ranks Tuesday over Monday for GOLDEN-1/2 (fewest new warnings) where the GOLDEN-1 unit test's own scripted model picks Monday — a legitimate model-implementation difference, not a bug, so the specs assert the move and the result rather than a specific target day. `scripts/run-e2e.mjs` now actually runs `playwright test`; `pnpm verify` passes with real E2E coverage for the first time.

Prerequisite for anyone running it locally: `pnpm exec playwright install chromium` (one-time; not run by `pnpm install`).

## TASK-605 CI — DONE

Run deterministic `verify`.

**Free scope**  
The repository is hosted on GitHub, so GitHub Actions is the executed pipeline. Author `.gitlab-ci.yml` with the same stages for portfolio purposes; it runs only if the repo is mirrored to GitLab.com.

**Status**  
Complete. `.github/workflows/ci.yml`: one job, on every push to `main` and every pull request, that installs dependencies, installs Playwright's Chromium (TASK-604), and runs `pnpm run verify` — the exact local completion gate, not a re-typed copy of its step order. `.gitlab-ci.yml` mirrors the same pipeline as separate staged jobs (TESTING.md §12's suggested list, plus `web` for the Angular specs) for portfolio purposes; it never executes here. Verified for real: pushed the branch, watched the Actions run to completion (`gh run watch`), all 9 `verify` steps green in CI.

---

# P7 — AWS / Infrastructure — DEFERRED (paid)

All P7 tasks require an AWS account. Free scope is limited to Terraform code plus `terraform validate`; never run `plan`/`apply` in this phase.

## TASK-701 Terraform foundation

Provider/backend conventions, variables, outputs, validation.

## TASK-702 SQS + DLQ

Terraform queue resources and least-privilege IAM.

## TASK-703 Bedrock permissions/config

Minimal required configuration and documentation.

## TASK-704 OpenSearch spike — optional, DEFERRED (paid)

Only after core MVP works.

Evaluate production-document search/RAG separately from dependency analysis.

## TASK-705 Deployment design — DEFERRED (paid)

Choose cost-conscious runtime and document trade-offs before provisioning.

---

# P8 — Portfolio Polish

## TASK-801 Seed/reset command — DONE

One command restores Demo Movie.

**Status**  
Complete. `pnpm run seed` (`scripts/seed.ts`) restores the Demo Movie fixture into the file store. `productions.save` (every adapter's ordinary seed/reset path) only ever touches a production's own entities, so a new `FileStore.resetProduction` (`packages/adapters/file-store`, file-store-only — the memory store is thrown away with the process, and Mongo is the portfolio target, not what this free-default command exists for) also clears every change request, proposal, approval, audit event, and idempotency record belonging to the production: a "restored" demo still carrying a previous run's stale proposals and audit trail would not be restored, just contaminated. `resetDemoMovie` (`@pca/bootstrap`) wires it to `PCA_STORAGE`/`PCA_DATA_FILE` and refuses loudly for any storage kind but `file`; it is exactly the function TASK-806's future `seed` CLI subcommand will call. 5 new tests (2 file-store integration, 3 bootstrap unit); `pnpm verify` passes.

## TASK-802 Architecture diagram — DONE

Create original diagram from `ARCHITECTURE.md`.

**Status**  
Complete. `ARCHITECTURE.md` §4's component diagram and §8's change-engine
pipeline are now Mermaid flowcharts (GitHub/Claude render Mermaid natively,
so no separate image asset to keep in sync) instead of ASCII art, both
original and both tied to the actual codebase rather than the aspirational
target stack: §4 names every adapter each port can select and marks the
free defaults, and §8 extends the pipeline through the approval diamond and
`Write`/`Verify` to visualize CLAUDE.md's non-negotiable rule 8 (`READ →
ANALYZE → SIMULATE → VALIDATE → PROPOSE → APPROVE → WRITE → VERIFY`).

## TASK-803 Demo script — DONE

2–4 minute demo based on `DESIGN.md`.

**Status**  
Complete. `docs/DEMO_SCRIPT.md` expands DESIGN.md §10's ten-step story into
a timed, two-part script (GOLDEN-1 as the ~2-minute core, GOLDEN-3 as the
~45-second quick replay DESIGN.md §10 step 10 calls for) with exact actions
and talking points per DESIGN.md §1's four questions, an "if asked" appendix
for interview Q&A, and a recording note that deliberately does not commit to
a single target day for the reschedule (Monday vs. Tuesday), matching what
`e2e/golden-1-sarah-unavailable.spec.ts` actually asserts — a demo script
that contradicted the real system on a live rerun would be worse than none.

## TASK-804 Performance instrumentation — DONE

Add correlation IDs/timings for model, MCP, DB, and analysis.

**Status**  
Complete. Correlation IDs for HTTP/agent job/queue message/MCP call were already contract-enforced and threaded end to end before this task; a proposal and an approval deliberately carry none of their own, tracing back to their originating request through `changeRequestId`/`AuditEvent.correlationId` instead (ARCHITECTURE.md §16 now explains why a redundant field would not add anything), and an MCP call stays server-generated only (accepting a caller-supplied ID from a model is a trust boundary this product does not cross). The real gap — and this task's actual scope — was latency: HTTP and MCP tool call `durationMs` already existed; model calls, database operations, and dependency analysis had neither timing nor a logger to write it to. `Logger`/`LogFields` (`packages/application/src/ports/logging.ts`) is a new shared port, promoted out of `apps/api` and `apps/mcp-server`'s two previously-duplicated logger types (both now alias it). `guardPort`/`guardRepositories` log a `db_call` line per repository call across every adapter for free (they already wrap every method); `guardModelPort` logs `model_call`; `analyzeChangeImpact` logs `dependency_analysis` with the correlation ID it already has. Every real entry point (`apps/api/src/main.ts`, `apps/mcp-server/src/main.ts`, `apps/api/e2e/server.ts`) now passes its logger through, verified for real by grepping a live E2E run's output for all three new event types. One thing this surfaced: `apps/api/src/main.ts` already guarded its model twice (bootstrap, then again inside `createRunChangeAgent`); logging both would have doubled every line, so `main.ts` logs only at the layer actually used, leaving the pre-existing double-guard itself untouched. 16 new tests (13 application unit, 2 bootstrap unit, 1 MCP contract); `pnpm verify` passes.

## TASK-805 README finalization — DONE

Screenshots, setup, architecture, trade-offs, limitations.

**Status**  
Complete. Five screenshots (`docs/screenshots/`) captured from a real run —
`pnpm run seed`, the real API and `ng serve`, driven through GOLDEN-1 in an
actual browser — show the workspace, impact/plan panels, approval
confirmation, audit trail, and the post-approval schedule; not mockups.
README gained a Screenshots section up top, an Architecture section
summarizing `ARCHITECTURE.md` §4/§8 with a pointer to the new diagrams, a
Trade-offs section (deterministic-engine-narrow-AI-surface, free-first
defaults vs. the target stack, GitHub Actions vs. documentation-only GitLab
CI, file store vs. an embedded database), and a Limitations section (no
auth beyond the actor header/allow-list, fixed-phrasing model, simple
candidate generator, no multi-writer concurrency, no OpenSearch/RAG, single
local file store). Setup instructions were already current from earlier
tasks and needed no changes. `docs/DEMO_SCRIPT.md` added to the reading
order.

## TASK-806 npm publishing — single package, full functionality, zero cost

**Goal**  
Publish one public npm package that runs the whole product on a clean machine with `npx` and no paid service.

**Dependencies**  
TASK-101 (file store), TASK-302 (rule interpreter), TASK-110, TASK-207, TASK-501..508, TASK-801.

**Scope**

- package `production-change-agent` (name free on npm as of 2026-09-10), `publishConfig.access: "public"`
- CLI with three subcommands:
  - `seed` — reset Demo Movie into the file store
  - `serve` — Express API + prebuilt Angular static assets + WebSocket on a local port
  - `mcp` — stdio MCP server over the same file store
- defaults: `PCA_STORAGE=file`, `PCA_MODEL=rules`, in-process queue; env vars switch to Mongo / Ollama / Bedrock
- `apps/web` build output copied into the package `files`; `apps/web`, `apps/api`, fixtures, test-support are not published separately
- `workspace:*` deps resolved by `pnpm publish`; `dist/` with `.d.ts`
- optional GitHub Actions publish job with provenance (free)

**Acceptance**

- `pnpm publish --dry-run` succeeds from a clean checkout;
- on a machine with only Node installed, `npx production-change-agent seed && npx production-change-agent serve` runs the three golden scenarios end-to-end through the UI;
- `npx production-change-agent mcp` passes the MCP contract suite;
- no AWS credential, MongoDB server, or API key is required in the default configuration.

**Known limits**

- free-form sentences outside the rule patterns need Ollama (free, user-installed);
- the file store admits one writer at a time (a lock file serialises instances and processes, TASK-903); busy multi-writer deployments should switch to Mongo.

---

# Post-review remediation (2026-09-11)

Three independent reviews of revision `c6ddb4ee9b4cbc55e826fd2703dbe003a2a3b626` — `docs/01_COMPREHENSIVE_CODE_REVIEW.md`, `docs/02_SECURITY_REVIEW.md`, `docs/03_FULL_SECURITY_ARCHITECTURE_AUDIT.md` — found substantial overlap: the same underlying defect is often finding #N in the code review, SEC-NNN in the security review, and AUD-NNN in the full audit. Each task below is filed once under the numbering scheme here (`TASK-9NN`) and cites every report finding it closes, rather than being fixed three times under three labels. Tasks are worked one at a time, in the order the reports were read (code review first, by severity; then security-review-only findings; then audit-only findings), with the human confirming before each next task starts.

TASK-901–913 closed every code-review finding through #16. The remaining findings — code review #17–#21, every security-review finding not already covered, and every audit-only finding — are filed as TASK-914–937 below in the security review's remediation order (identity first, then defaults and boundary limits, then workflow integrity and data protection, then supply chain and defence in depth, then code-quality leftovers).

## TASK-901 Atomic apply-approved-proposal commit — DONE

Code review finding #1 (Critical) / SEC-005 (High) / AUD-002 (Critical): the production mutation, idempotency record, proposal `APPLIED` status, and audit event were four separate writes. A failure after the first left the mutation committed with some or all bookkeeping missing, and a replay saw the advanced version before an idempotency record existed, returning `PRODUCTION_VERSION_MISMATCH` instead of recovering.

**Status**  
Complete. `RepositorySet` gained `applyProposalTransaction(commit)` (`packages/application/src/ports/repositories.ts`): one atomic operation that commits the version-checked mutation together with the idempotency record, the proposal's next status, and its audit event, returning the same `CommitOutcome` shape `productions.commit` already uses. All three adapters implement it as a genuine unit of work rather than a wrapper around four calls: the file store folds it into one `#mutate` read-modify-write-rename cycle (reusing the existing `commitInto`); the memory store runs it as one synchronous pass with no `await` between the mutation and the three follow-up writes; Mongo extended its existing `session.withTransaction` (refactored `#commit` to accept an in-transaction continuation) so the proposal/idempotency/audit writes commit inside the same transaction as the version-checked update, aborting together on a version mismatch. `apply-approved-proposal.ts` now builds the idempotency record and audit event from the mutation up front (the post-commit version is `expectedVersion + 1` whenever the outcome is `COMMITTED`, the same invariant `productions.commit` already guarantees) and makes the single atomic call instead of four sequential ones.

Each method is declared as an arrow-function class field, not a class method: `guardRepositories` and bootstrap's `repositorySetOf` copy `RepositorySet` members out by property access (`Object.entries`/direct reference), and only a field is both an own enumerable property and carries its `this` binding when copied — a class method would silently lose its adapter instance the first time it was extracted this way. `guardPort`/`guardRepositories` (TASK-804's logging/error-wrapping layer) were extended to guard a `RepositorySet` member that is itself a function (not just nested port objects), so `applyProposalTransaction` gets the same `InfrastructureError` naming and `db_call` timing as every other repository call, verified live in the E2E run's log output (`memory.applyProposalTransaction`, one line per apply, replacing what were four).

9 new tests: 3 in the shared repository contract suite (`packages/test-support/src/repository-contract.ts`, run against all three adapters — commits all four together, leaves all four untouched on a version mismatch, serializes concurrent applies so the loser leaves no partial bookkeeping) plus updates to two existing failure-injection tests that used to fault `productions.commit` to exercise the apply path's failure handling — they now fault `applyProposalTransaction` directly, since that is the call the use case actually makes. `pnpm run verify` passes (9/9 steps); `pnpm run test:integration` passes against a real Mongo replica set (`mongodb-memory-server`), proving the transaction actually rolls back atomically, not just that the code compiles against the port.

## TASK-902 Atomic, race-safe proposal decision — DONE

Code review finding #2 (Critical) / SEC-004 (High) / AUD-004 (High): decision finality was a read-then-write — `findByProposalId`, then three separate saves — with no compare-and-set. Two concurrent callers could both see "no decision", both succeed, and leave an APPROVE and a REJECT record for one proposal, with the proposal status reflecting whichever save came last and `findByProposalId` returning an arbitrary one. An approval record could stay usable by the write guard after a human had rejected.

**Status**  
Complete. `RepositorySet` gained `recordProposalDecision(commit)`: one atomic write of the approval, the decided proposal status, and the audit event, with "no approval exists for this proposal yet" as the compare-and-set. Its outcome is a value, not an exception — `RECORDED`, or `ALREADY_DECIDED` carrying the record that won — so the loser of a race can answer exactly as if the decision had existed before it started. `decide-proposal.ts` keeps its cheap early read (a settled proposal skips re-simulation) but the write is now the atomic call, and a lost race is routed through the same "same decision → no-op / different decision → `CONSTRAINT_VIOLATION`, a decision is final" path. Adapters: the file store does the check and the three writes in one `#mutate` cycle; the memory store in one synchronous pass; Mongo in one transaction with the guarantee held by the database itself — the `approvals` index on `(productionId, proposalId)` is now unique, so the true race (two transactions both reading nothing) ends with the loser's insert failing on duplicate key, its transaction aborting, and the adapter re-reading the winner. Because Mongo refuses to change an existing index's options in place, `#ensureIndexes` drops the pre-task non-unique index with the same key before creating the unique one; a fresh database has nothing to drop.

One regression this surfaced, and fixed: `withProposalNotifications` (TASK-404's realtime decorator) assumed every proposal status change passes through `proposals.save`. TASK-901 had already silently broken that for `APPLIED` — nothing tested apply notifications — and TASK-902 broke it for decisions, which the realtime suite did catch. The decorator now also wraps both atomic writes, notifying only when the write actually landed (`COMMITTED`/`RECORDED`), so a client never hears a status the store never held.

10 new tests: 4 in the shared repository contract suite (run against file, memory, and a real Mongo replica set — records all three together; refuses a second decision and writes nothing; exactly one of two simultaneous opposite decisions wins, with the loser handed the winner's record; production scoping), 1 use-case race test in `proposal-lifecycle.test.ts` (concurrent APPROVE/REJECT through `decideProposal`: one succeeds, the other is refused as contradicting a final decision, stored status agrees with the stored approval), and 1 realtime test covering the notification gap (a concurrent decision race yields exactly one decision notification, then `APPLIED` through the atomic apply). `pnpm run verify` passes (9/9).

## TASK-903 File-store writer lock across instances and processes — DONE

Code review finding #3 (Critical) / AUD-006 (High): `FileStore` serialised writes only through an in-object `#writeQueue`. Two instances in one process, or two processes on the same `PCA_DATA_FILE`, each read version N and each renamed its own N+1 into place; both reported `COMMITTED` and the later rename silently discarded the earlier approved mutation and its records. The adapter is the runtime default, and a `seed` beside a running API, a second server, or a stray test handle are all ordinary ways to get there.

**Status**  
Complete. Every `#mutate` cycle now holds an exclusive lock file (`<data file>.lock`, created with `O_EXCL` via `fs.open(..., "wx")` — the one primitive every platform makes atomic) for its whole read-check-write, and releases it in `finally`. The lock records the owner's pid; a waiter polls every 10ms and either acquires, reclaims a lock whose pid is no longer alive (`process.kill(pid, 0)` → `ESRCH`), or gives up after `lockTimeoutMs` (default 5s) with a `STORE_LOCKED` error that names the file and says what to do — never a silent lost update. Reclaiming goes through `rename` to a unique name before `unlink`, so two waiters that both find the same abandoned lock cannot have the second one remove a lock a third writer created in between. `resetProduction` (the seed path) goes through the same `#mutate`, so the report's "make the seed/reset command acquire the same lock" is met without a separate code path. Reads take no lock: rename is atomic, so a reader sees a whole file, before or after.

The report offered "fail startup when another process owns the data file" as the minimum alternative; the per-mutation lock was chosen instead because exclusive ownership would forbid a documented use (running `seed` while the API is up, and TASK-806's `seed`/`serve` subcommands sharing one store), and because it is the lock across the read-check-write, not startup exclusion, that actually prevents the lost update.

5 new tests, all against a real filesystem: in the shared repository contract, concurrent commits from two separately opened handles (run against the file store and, via its `reopen`, Mongo — which already serialised through transactions); in the file-store suite, two instances racing in one process, two *processes* racing (a `tsx` worker spawned twice against one file — the exact reproduction in the report), an abandoned lock from a dead pid reclaimed transparently, and a lock held by a live pid waited for and then refused with `STORE_LOCKED` while leaving the store untouched. The existing "leaves no temporary files behind" test now also proves the lock file is always released. `pnpm run verify` passes (9/9).

## TASK-904 Candidate generation sees the newly reported unavailability — DONE

Code review finding #4 (High): for `CAST_UNAVAILABLE` and `LOCATION_UNAVAILABLE`, `runChangeAgent` generated candidate days from the stored production state, without the fact it was about to record. A multi-day unavailability (Friday through Monday, say) could therefore rank Monday, and the proposal then failed simulation as INVALID — although Tuesday was free, or although the honest answer was NO_CANDIDATE. The user saw a failed plan instead of either.

**Status**  
Complete. The agent now applies the fact operation to a copy of the state (`applyOperations`, throwaway ID allocator) and runs the domain `generateScheduleCandidates` against that post-fact index directly, instead of the `generateScheduleCandidates` use case, which reloads the stored state. The generator's own availability check then refuses days inside the reported range with the real reason (`Sarah is unavailable on 2026-09-21 …`) — the same reason simulation would have given, one step earlier — so the ranked list only ever contains days the fact leaves open. The report's alternative, passing the range as `excludeDates`, was not taken: it would only cover the subject's own dates, whereas applying the fact covers every consequence the domain already knows how to evaluate. The MCP tool `generate_schedule_candidates` is unchanged: a read answers against the stored state, and a caller with a pending fact has `excludeDates` for it (ARCHITECTURE.md §8). The report's further suggestion — try the next ranked candidate if one unexpectedly fails simulation — was left out deliberately: the generator and the simulator apply the same availability rules to the same post-fact world, the model can only permute the generator's list, and there is no path that would exercise the fallback; untested defensive code is the wrong trade.

One visible side effect, and an improvement: the source day now also appears in `rejected` with the availability reason, not only "a moving scene is already scheduled there", so the candidate comparison panel tells the whole truth. 2 new tests in `run-change-agent.test.ts` (Friday-through-Monday proposes Tuesday with Monday refused for the real reason; Friday-through-Tuesday reports NO_CANDIDATE with no draft persisted), 1 job-handler expectation updated for the extra reason. `pnpm run verify` passes (9/9).

## TASK-905 Job tracker atomic updates and retry re-entry — DONE

Code review findings #5 and #6 (High) / AUD-013, taken together because the second is a precondition of the first. #6: `JobTracker.advance/fail/note` each loaded a run, transformed it, and saved it back with no revision check or per-job serialisation, so the queue binder's retry `note` and a handler's `advance` could overwrite each other — a reproduction ended with the run back at `received`, its move to `analyzing` erased. #5: a queue exception at `simulating` or `validating` redelivered the job with the run left at that stage; the handler re-ran the orchestration from the top, whose first progress callback asked to move back to `analyzing`, and the graph rightly threw `JobStageError` on every attempt until the job was dead-lettered — a transient fault made permanent — while each rerun also submitted a duplicate change request.

**Status**  
Complete. `JobRunRepository` gained `update(jobId, transform)`: load, transform, store as one atomic step, `transform` pure and allowed to throw (nothing is written then), `null` for an unknown job. The in-memory adapter runs it with no `await` between read and write; a durable adapter would implement it with a compare-and-set on a revision. The tracker's three moves are now single `update` calls, and events are published only for what actually landed. A read-only `JobRunReader` (`findById` + `listByProduction`) is what the query use cases now take, so `apps/api` no longer fakes a write side to satisfy the type.

For re-entry, the analyze handler's progress callback is monotonic: `isAtOrBeyond(current, target)` (stage-machine, with `failed` beyond everything) answers "already there" for any stage the run has reached or passed, so a retry at `simulating` skips `analyzing`/`simulating` and advances from `validating` on. The handler no longer pre-advances into `analyzing` itself; `runChangeAgent` reports `{ changeRequestId }` on its first progress callback and the handler records it on the run right there, then hands `run.changeRequestId` back on redelivery. `runChangeAgent` accepts that ID, loads the stored request, takes its change from the record (no re-interpretation), and skips `submit` — one `CHANGE_REQUEST_SUBMITTED` per job however many attempts. A stale ID degrades to a fresh submission rather than a failure. Two things deliberately left: the analysis audit lines (`ANALYSIS_REQUESTED`/`ANALYSIS_COMPLETED`) repeat on a retry because analysis genuinely ran again; and the narrow window where the request is written but the very next tracker write fails still yields one duplicate on retry — closing it needs an idempotency key on `submitChangeRequest`, which is the report's broader suggestion and its own task.

5 new tests: tracker — a concurrent `advance` and `note` both land in order, and a refused move writes and publishes nothing; stage machine — `isAtOrBeyond` over the happy path and `failed`; handlers — an end-to-end redelivery through the memory queue where the first attempt throws as the loop enters `simulating`: the retry completes at `awaiting_approval`, never re-enters `analyzing`/`simulating`, the run carries the one change request, and no second one exists. `pnpm run verify` passes (9/9).

## TASK-906 File-store write validation and identity/tracing header validation — DONE

Code review finding #7 (High) / SEC-006 (High) / AUD-010 (High): the file store validated its on-disk schema only on read, and the REST API trimmed `X-Correlation-Id`/`X-Actor-Id` without parsing them. The persisted contracts cap a correlation ID at 128 characters and an actor at 200, so one request with a 129-character correlation ID wrote a change request successfully, the following audit append failed, and every later read of the whole database failed with `STORE_CORRUPT` — a restart did not recover it. Any reachable caller could turn one request into a persistent denial of service; `PCA_ACTOR_ID` from the environment had the same gap.

**Status**  
Complete, at both ends of the path. The store: `FileStore.#write` parses the complete next database with `fileDatabaseSchema` before the temporary file is written — the same schema every read already used — and refuses with `STORE_INVALID_WRITE` naming the offending field; because nothing has been written yet, the previous database is untouched and the record that caused it is simply not saved. The boundary: `apps/api`'s `callOf` validates both headers against new shared `actorIdSchema` (1–200, the limit `createdBy`/`approvedBy`/`actorId` already enforce) and the existing `correlationIdSchema`. An unusable correlation ID is replaced with a fresh one and the request proceeds — tracing degrades, work does not — while an unusable `X-Actor-Id` is refused with 400 `INVALID_INPUT`, because an identity is written into approvals and the audit trail and must not be silently swapped for the server default. `contextFromEnv` holds `PCA_ACTOR_ID` to the same rule at startup, so a misconfigured server refuses to start instead of writing records it could never read back. Memory and Mongo adapters validate on write only where they already did; extending save-time schemas to them is defence in depth the report suggests and belongs with SEC-015/AUD-020 (Mongo read-side validation), a later task.

4 new tests: file store — a 129-character correlation ID is refused with the field named, the production still loads, the record is absent, no stray files; API contract — an over-long correlation header yields 200 with a fresh `corr-` ID, an over-long actor header yields 400 `INVALID_INPUT` naming `X-Actor-Id`, both still echoing a valid correlation ID; MCP context — a valid `PCA_ACTOR_ID` is accepted, an over-long or empty one throws at startup naming the variable. `pnpm run verify` passes (9/9).

## TASK-907 Record identity scoped by production in every adapter — DONE

Code review finding #8 (High) / AUD-005 (High): production isolation (INV-4) is an authorization boundary, and record identity was not consistently scoped by it. The file store's `replaceById` matched workflow records on `id` alone although its arrays hold every production's records, so production A's proposal `P-104` overwrote production B's. The memory store and Mongo built flat keys as the unescaped string `${productionId}::${id}`, and entity IDs may contain colons, so `(A, B::P)` and `(A::B, P)` were one key. ID generation makes this rare in ordinary runtime; imports, fixtures, deterministic IDs, and colon-bearing IDs make it reachable.

**Status**  
Complete. `scopedRecordKey(productionId, id)` (`@pca/application`, beside `assertBelongsToProduction`) is the one encoding every flat-keyed adapter uses: each part has `%` escaped first and then `:` as `%3A`, so the separator is unambiguous and an escape cannot be forged from inside an ID. `%` is outside the entity-ID alphabet, so an ID without a colon encodes to exactly the `productionId::id` string Mongo rows were always written with — existing data keeps its `_id`, no migration, and the report's alternative of a structured `_id` (which would have required one) was not needed. Mongo's `rowId` and the memory store's `scopedKey` delegate to it; the file store's `replaceById` now compares `productionId` and `id` together. No unique compound index was added on the entity collections: with the escaped `_id`, `_id` uniqueness already is `(productionId, id)` uniqueness.

6 new tests: 3 in the shared repository contract, run against file, memory, and a real Mongo replica set — a proposal ID and a change-request ID that repeat across two productions stay two records each, and `(A, B::P)` versus `(A::B, P)` resolve to their own records with `(A, P)` absent; 3 unit tests on the encoding itself — colon-free IDs encode byte-for-byte as before, the two colliding tuples differ, and the escape character is escaped first. `pnpm run verify` passes (9/9).

## TASK-908 Rule interpreter: refuse positive availability, keep date ranges whole — DONE

Code review finding #9 (High): the rule-based interpreter's `UNAVAILABLE` pattern explicitly matched `is available` and `are available`, so "Sarah is available Friday" resolved to `CAST_UNAVAILABLE` — the opposite of what was said — and `resolveDate` captured only the first ISO date or month/day, so "cannot shoot 2026-09-18 to 2026-09-22" became a one-day range. Because the UI proceeds straight to proposal generation, both put a materially wrong plan one approval away from being recorded.

**Status**  
Complete, in `packages/adapters/rule-model`. Intent is split: `UNAVAILABLE` now matches negative forms only (`is not available`, `isn't available`, `is unavailable`, `cannot`, `is out`, `closed`, …), and a separate `AVAILABLE` pattern recognises positive forms (`is available`, `is available again`, `can shoot`, `is free`, `is back`) and refuses them as `UNSUPPORTED` with a reason that says why: only unavailability can be recorded today, there is no change type for becoming available again, and nothing was interpreted. Date ranges are tried before single dates, for all three spellings the sentence shapes use — ISO (`2026-09-18 to 2026-09-22`), month/day with or without a repeated month (`September 18 through September 22`, `September 18–22`), and weekday (`Friday through Monday`, resolved against the production's shoot days: the earliest on the first weekday to the first on the second weekday after it, with a first weekday that matches several shoot days refused as "give the range as dates" rather than guessed). Joiners are `to`, `through`, `thru`, `until`, `till`, and the three dashes. Every endpoint is validated as a real calendar date (`2026-13-45` and `2026-09-31` are refused by name, not accepted as strings that happen to match the shape), and a range whose end precedes its start is refused with both dates in the reason. Single dates go through the same validation, which they did not before.

20 new tests in the adapter's suite: five range sentences across all three spellings keep the whole range; a location range; four refusals (end before start, an impossible single date, an impossible range end, a weekday with no later shoot day) each naming the reason; the ambiguous-first-weekday case; six positive sentences refused with the "only unavailability" reason; and three negative contractions (`is not`, `isn't`, `aren't`) confirmed to still read as unavailability so the split did not narrow what worked. The three golden sentences and every prior close variant are unchanged. `pnpm run verify` passes (9/9).

## TASK-909 Preparation tasks must reference entities that exist — DONE

Code review finding #10 (High): `CREATE_PREPARATION_TASK` inserted a task without checking that its `relatedEntityType`/`relatedEntityId` named anything, and INV-3 (`checkSceneIntegrity`) validated scene, shoot-day, call-sheet, and requirement links but never task links. An MCP caller could therefore get a proposal with a task linked to `SCENE NONEXISTENT` through simulation, approval, apply, and verification, all reporting valid — an orphan the UI and API could not resolve and dependency traversal could not follow.

**Status**  
Complete, at both places the report named. Simulation: `CREATE_PREPARATION_TASK` now resolves the target by the type it names — scene, shoot day, call sheet, or requirement — against the draft, and an absent target is an `UNKNOWN_ENTITY_REFERENCE` conflict on that entity with no task created, the same shape a missing call sheet or shoot day already produced. Checking the draft rather than the original state matters: a task may legitimately name a requirement an earlier operation in the same proposal creates (GOLDEN-3's "add the red car, then a task to source it"), and that keeps working. Invariant: INV-3 gained a task loop, so an orphan task in *stored* state is reported as `UNKNOWN_ENTITY_REFERENCE` on the task with the title and target in the detail — caught by `verify_applied_proposal` and every other invariant check regardless of how it got there, which is the layer the operation-level check cannot cover. DOMAIN.md INV-3 now states the rule.

4 new tests: simulation refuses a task for a missing scene and one for a missing call sheet, each as a conflict naming the type and ID, with no task created; a task naming a requirement the previous operation creates applies cleanly; INV-3 rejects two stored orphans (scene and shoot-day targets) as `INV-3`/`UNKNOWN_ENTITY_REFERENCE` on the task, and accepts a task whose target exists. `pnpm run verify` passes (9/9).

## TASK-910 Realtime client: closed proposals leave the open list; failed recovery retries — DONE

Code review findings #11 and #12 (Medium), both in `packages/realtime-client/src/index.ts`. #11: a notification for a known proposal was merged in place whatever its status, so `APPLIED`, `REJECTED`, and `FAILED` records stayed in `openProposals` — an array whose contract is "what a coordinator still has to act on" — and nothing advanced `productionVersion` after an apply, so the header kept the old version until a reconnect or a manual recovery. #12: when the REST snapshot read failed, the catch path cleared the held notifications, marked the view not recovering, and returned; with no retry and no reconnect the view stayed stale for as long as the socket stayed quiet, even though the socket itself was healthy.

**Status**  
Complete. Terminal statuses: after merging the notification, a proposal whose status is outside `OPEN_PROPOSAL_STATUSES` (the same list the recovery snapshot is built from) is removed from `openProposals`; `APPLIED` additionally triggers a recovery, because the write moved the production version (INV-7) and only the record says to what — `REJECTED` and `FAILED` do not read again, since the version did not move. The recover-on-unknown path is unchanged. Failed reads: the held notifications stay held and the view stays `recovering`, so notifications arriving during the outage are held too rather than applied to nothing; the read is retried through the injected scheduler with the client's existing backoff (500 ms doubling, capped at 30 s), counted per production and reset by a successful read; `onRecoveryError` fires on every attempt. A manual `recover()` while a retry is pending runs the read now and cancels the retry; a socket drop or `close()` cancels the retry, drops what was held, and clears `recovering`, so the reconnect's `subscribed` starts recovery from scratch exactly once; `unfollow` cancels it too. The console's `RealtimeService` clears `lastRecoveryError` when a fresh snapshot lands. ARCHITECTURE.md §11 documents both rules.

9 new tests in `packages/realtime-client` (one existing test rewritten to the new contract): APPLIED removes the proposal and a second read brings version 2 with the closed record never shown as open; REJECTED and FAILED remove without a read; APPROVED stays; a failed read keeps holding, schedules a 500 ms retry, holds a job event that arrives meanwhile, and applies snapshot then held after the retry; consecutive failures back off 500 → 1000 and reset after success; manual recover runs now and cancels the retry; a socket drop cancels the retry and the reconnect recovers once from scratch; `close()` cancels the retry. 1 new web spec: the error message shows after a failed read and clears once a manual recovery succeeds. `pnpm run verify` passes (9/9).

## TASK-911 A scene move must stale the published call sheets of the days it changes — DONE

Code review finding #13 (Medium). The orchestrated `SCHEDULE_CHANGED` path adds `MARK_CALL_SHEET_STALE` for every published sheet of the source and target days, but an MCP caller could submit a bare `MOVE_SCENES` and simulation, validation, approval, apply, and verification all reported it valid while both days' call sheets stayed `PUBLISHED` — crew-facing documents describing a day the plan no longer matched.

**Status**  
Complete, as explicit operations plus a validation rule rather than an implied write. `simulateProposal` now collects the source and target days of every applied `MOVE_SCENES` and reports `CALL_SHEET_PUBLISHED_FOR_CHANGED_SHOOT_DAY` (new conflict code) on each call sheet of those days that is still `PUBLISHED` in the would-be state, with the date and the operation to add in the detail; the proposal is invalid until the marks are there. Reading the post-state means the mark may appear anywhere in the proposal and a sheet already in `DRAFT` needs none; a move that could not apply asks for nothing. The move does not imply the mark on purpose: the digest a coordinator approves covers the operations, so a write that changes a call sheet must be one of them — the same principle as "recording the fact alone is a valid operation but an invalid proposal". Because approval re-simulates, a stored proposal created before this rule is also refused at approval if it lacks the marks. DOMAIN.md (operations) and MCP.md (`simulate_proposal`) state the rule.

4 new domain tests (bare move invalid naming both sheets while Sarah's conflicts still resolve; marking one day leaves the other as the sole conflict; an already-draft sheet needs no mark and the mark may precede the move; a move that could not apply asks for no marks) and 1 MCP contract test reproducing the review's case (Scene 18 moved by hand → invalid with the two sheets named). Three existing tests that used bare moves to exercise other conflicts now carry the marks so they assert what they meant to. `pnpm run verify` passes (9/9).

## TASK-912 Verification check names honour the MCP output contract — DONE

Code review finding #14 (Medium). Verification check names embedded user-controlled text — task titles (up to 300 characters), requirement names and cast/location names (up to 200) — while `verify_applied_proposal`'s output schema caps a name at 120. The use case succeeded, then MCP output validation turned the result into `INTERNAL_ERROR`: a valid, applied proposal became unverifiable through the public tool because of display-text length. The reviewer reproduced it with a 150-character title yielding a 172-character name.

**Status**  
Complete, with producer and contract sharing the limits. `@pca/contracts` exports `VERIFICATION_CHECK_NAME_MAX_LENGTH` (120, used by the output schema) and `EXPLANATION_MAX_LENGTH` (2,000, used by `explanationSchema`). The domain verifier clips every user-written fragment it quotes in a name to 30 characters with an ellipsis — sized so the two-fragment template "No scene requiring X remains scheduled while X is unavailable" fits whole — and, as the guarantee, clips every finished name to 120 and every detail to 2,000 in the one `check()` constructor all checks pass through, so a move of many scenes or an invariant report with many violations is bounded too. Names stay readable: "Sarah", "Warehouse", "red car", and "Source a red car for Scene 18" are all under the fragment limit and unchanged. The full task title moved into the task check's detail, so nothing the name drops is lost. MCP.md §8 states the rule.

Tests: 4 domain (a 300-character title clips in the name and appears whole in the detail; a 200-character cast name clips in the operation check and both places in the availability check, all five names within the limit; an invariant detail with 60 violations is cut at exactly 2,000 ending in an ellipsis; `clip` boundaries), 1 contracts boundary (120 accepted, 121 refused), 1 MCP contract (a proposal with a 300-character title runs create → approve → apply and `verify_applied_proposal` returns success rather than `INTERNAL_ERROR`). One existing detail assertion updated for the title now quoted. `pnpm run verify` passes (9/9).

## TASK-913 Web schedule and audit pages: guarded loads, error state, one read — DONE

Code review findings #15 and #16 (Medium). #15: both pages launched their requests from an `effect` with no catch and no ownership check, so a failure became an unhandled rejection with the page stuck on "Loading…", and switching productions while a slow answer was in flight let the previous production's rows land under the new header. #16: the schedule page followed `get_schedule` with one `get_scene` per distinct scene, each of which loaded and indexed the whole production again — N+1 full snapshot reads on the page meant to show the whole schedule, and `Promise.all` let one missing scene fail the lot.

**Status**  
Complete. Server: `get_schedule` gained `includeScenes`; when set, the handler resolves every distinct scene the returned days name — in day order, normalized exactly like `get_scene` through a shared `normalizeScene` — from the index it already built, so the whole page is one production read. A scene ID a day names that cannot be resolved is left out rather than failing the call (the caller shows it by ID; INV-3 reports the corruption). REST passes `?includeScenes=true` through. Web: a `PageLoad<T>` state (`loading` | `ready` | `error`) replaces the nullable rows, and a `latestOnly()` ticket guard makes only the newest request able to write, so a straggling answer about a production the page has left is dropped whether it succeeds or fails. Failures render the server's `ToolError` — code, message, next step — with a Retry button, the same shape the header and the change input already use; `toToolError` moved to the API client so the store and both pages share it. The schedule page makes one request and never calls `get_scene`. MCP.md documents the option.

Tests: MCP contract (`includeScenes` returns the four demo scenes in day order, normalized, with exactly one `loadState` call counted on the store; the plain call has no `scenes`); REST contract (`?includeScenes=true` carries the day's scenes, plain call does not); web — schedule page renders from the one request and asserts `get_scene` is never called, shows the error with next step and retries to a rendered page, and drops a late answer from the previous production; audit page shows the error, ignores a late answer from the previous production, and retries; `latestOnly` unit. `pnpm run verify` passes (9/9).

## TASK-914 Authenticated identity and a real approver role — DONE

SEC-001 (Critical) / AUD-001 (Critical). The API accepted `X-Actor-Id` as the user: anyone who could reach it could approve a proposal under any name and apply it, and the approval and audit records would attribute the decision to the victim. The shape of an approval was enforced; the authority of its issuer was not.

**Status**  
Complete. Identity is now a verified fact behind one application port. `IdentityPort` (`packages/application/src/ports/identity.ts`) turns a credential into a `Principal` — subject, issuer, actor type, ordered roles `viewer` < `requester` < `approver`, and the productions granted — or a refusal that names why without echoing the credential. `Principal`, the roles, and the two pure checks (`principalHasRole`, `principalMayAccess`) live in `@pca/contracts`. The free adapter is `@pca/local-auth`: HMAC-SHA256-signed `pca1.<claims>.<signature>` tokens, one algorithm, constant-time comparison before the claims are parsed, optional expiry. `selectAuth` (`@pca/bootstrap`) chooses the mode from the environment and never from a request: **token** (`PCA_AUTH_SECRET`, tokens minted by the operator with `pnpm run token`, maker-checker on unless `PCA_MAKER_CHECKER=false`) or **demo** (`PCA_DEMO_MODE=true`, an ephemeral secret, `GET /api/auth/demo-session` hands anyone the demo coordinator's token, maker-checker off, a startup warning); neither set and the server refuses to start.

REST (`apps/api`): every route but `/health` and the demo-session route requires `Authorization: Bearer <token>`; a missing or bad token is `UNAUTHENTICATED` (401, new code, HTTP-only). `X-Actor-Id` is gone — the call's actor is the principal's subject, so `approvedBy`, `createdBy`, `requestedBy`, `appliedBy`, and every audit `actorId` come from the token. A production must be on the server's allow-list *and* in the principal's grant, and reads need `viewer`, writes `requester`, before any handler runs. The `approver` check for a decision, and maker-checker (the change request's `createdBy` may not decide the proposal that answers it), are in `decideProposal` itself, so no delivery adapter can skip them; `decidedBy` is now an `Approver` (`subject`, `issuer`, `roles`), and the approval records `approvedByIssuer`/`approvedByRole` (optional in the contract only so older approvals still parse) with the same in the audit event's metadata. The WebSocket gateway gained an `authenticate` hook that runs before `handleUpgrade` and answers a refusal with 401/403 and no socket; the API server feeds it the same verifier (token from `Authorization`, or `?access_token=` for browsers) and hands the principal to `authorize`, so a subscription needs the token's grant too. The MCP server is unchanged: the operator's process, `PCA_ACTOR_ID` as the agent identity, no approve tool.

Web: `AuthService` settles the session in an app initializer — a `sessionStorage` token, else the demo session, else a token prompt (`pca-token-prompt`, DESIGN.md §2) in the routed area; a functional interceptor adds the bearer header to API calls and clears the session on 401; the socket URL carries `access_token`. The shell opens the store and connects the socket only once the session is ready. `apps/api/e2e/server.ts` runs in demo mode, so the E2E suite exercises the real bearer path; the audit lines now read `demo-coordinator reported …`.

Tests: `@pca/local-auth` unit (round trip, wrong secret, edited claims, malformed, expired, future-dated, invalid principal, short secret, port); ws-gateway (401/403 before any socket, session handed to every subscription check, a throwing hook is a 401); API contract — 401 without/with a Basic header, forged and expired tokens, `X-Actor-Id` ignored (approval and audit carry the token's subject), a grant lacking the production, viewer/requester/approver gates, demo-session 404 outside demo mode, maker-checker refusing the submitter and accepting a second approver, the upgrade refused without a token and a subscription refused outside the grant, and demo mode issuing a token that works for REST and the socket; every existing `decidedBy` call site passes an `approver(...)` principal (`@pca/test-support`); web — `AuthService` (demo session, 404 → prompt, stored token reused, clear) and the interceptor (header on API calls only, never on the demo-session call, 401 clears). `pnpm run verify` passes (9/9).

Docs: `ARCHITECTURE.md` §6 REST and §15 "Identity"; `README.md` run/env/commands/limitations; `MCP.md` §9; `DOMAIN.md` Approval; `SPEC.md` FR-6; `DESIGN.md` §2; `TESTING.md` API tests.

Left for later tasks: TASK-915 makes the production allow-list fail closed the same way identity now does; TASK-916 adds Origin validation to the upgrade; TASK-919 binds jobs to the requester the token names.

## TASK-915 Authorization fails closed when the allow-list is missing — DONE

SEC-002 (High) / AUD-003 (High). `contextFromEnv` mapped an unset or blank `PCA_ALLOWED_PRODUCTIONS` to `"*"`, so the most ordinary deployment mistake — forgetting one variable — silently became access to every production for the REST API, the MCP server, and the WebSocket gateway alike.

**Status**  
Complete. `allowedProductionsFromEnv` (`apps/mcp-server/src/context.ts`, used by both entry points through `contextFromEnv`) now throws at startup when the variable is unset, blank, or `*` unless `PCA_DEMO_MODE=true` — the same explicit demo flag TASK-914 introduced for identity, so one flag marks "this is a local demo" and nothing else widens access. Every listed entry is parsed with `entityIdSchema` and a bad one fails startup naming the entry; a list is kept as-is even in demo mode. The error message says exactly what to set. `main.ts` for both servers refuses to start on the thrown error as before (exit 1, the message on stderr).

Tests: `contextFromEnv` unit — unset/blank/comma-only/`*` refused outside demo mode (and with `PCA_DEMO_MODE=false`), `*` granted only with the flag (case- and whitespace-insensitive), a list parsed and trimmed and kept in demo mode, an over-long and a malformed entry refused by name. `apps/api/test/main.integration.test.ts` boots the real API entry point as a child process: no allow-list and no demo flag → exit 1 with the actionable message; a malformed entry → exit 1 naming it; `PCA_DEMO_MODE=true` alone → `api_start` with `auth: demo`, `allowedProductions: *`, and the demo warning. `pnpm run verify` passes (9/9).

Docs: `README.md` env table (`PCA_ALLOWED_PRODUCTIONS` no longer defaults to `*`; `PCA_DEMO_MODE` described as the one demo flag); `MCP.md` §3; `ARCHITECTURE.md` §15; the MCP entry point's usage comment.

## TASK-916 WebSocket upgrade authentication and Origin validation — DONE

SEC-003 (High) / AUD-007 (High). Browsers open WebSockets cross-origin with no preflight, so a hostile page could point one at a developer's loopback API. TASK-914 already made the upgrade demand a token; this closes the other half — a page that holds a token (the developer's own browser) must also come from somewhere the server trusts.

**Status**  
Complete. `apps/api/src/origins.ts` owns the policy: `parseOrigins` accepts only exact origins (scheme, host, port — `new URL(x).origin === x`), `allowedOriginsFromEnv` reads `PCA_ALLOWED_ORIGINS` and defaults to the Angular dev server's two origins in demo mode and to nothing in a deployment, and `originAllowed` accepts an origin that is on that list or whose host is the server's own `Host` (same-origin, compared on host only because the scheme may differ at a TLS-terminating proxy). The API server's `authenticate` hook checks it before the token: an `Origin` that is neither is refused with 403 and a reason; a connection whose token rides the query string — the browser path — with no `Origin` at all is refused with 403 too, since only a client that can set `Authorization` (never a browser) has a reason to omit it. All of it happens before `handleUpgrade`, so no socket exists for a foreign page. The gateway needed no change: the hook TASK-914 added is where the policy runs. `main.ts` passes the parsed list and logs it (`(same-origin only)` when empty); the E2E server allows the dev UI. The web client needed no change — a browser always sends its Origin.

Tests: `apps/api/test/origins.test.ts` (exact-origin parsing and its refusals, defaults per mode, same-host and listed origins accepted, foreign/`null`/other-port/no-host refused); API contract — foreign and `null` Origin → 403 with either token transport, the server's own and a listed origin → 101, a query-string token without an Origin → 403 while a header token may omit it, and a missing or forged token still → 401 once the Origin is acceptable; the existing socket tests now send a same-origin `Origin` like a browser. `pnpm run verify` passes (9/9).

Docs: `README.md` env table (`PCA_ALLOWED_ORIGINS`); `ARCHITECTURE.md` §6; `TESTING.md` API tests.

Not done here: `Host`/forwarded-host validation against a trusted-proxy topology (AUD-016/TASK-930 territory), and the per-connection and rate limits of TASK-917.

## TASK-917 Resource limits: payload, rate, connection, and cardinality caps — DONE

SEC-007 (High) / AUD-008 (High). Nothing bounded the work a client could cause: the WebSocket server took `ws`'s 100 MiB default frame, there was no connection, message, or request quota, externally supplied arrays had `.min(1)` and no `.max()`, and finished jobs and runs accumulated for the life of the process.

**Status**  
Complete, in four places. **Contracts:** `INPUT_LIMITS` (`primitives.ts`) caps `sceneIds` per operation/change at 200, `operations` per simulation/proposal at 100, and `excludeDates` at 366, applied to every input schema that carries them (and to the stored proposal, which inputs already satisfy); over the cap is `INVALID_INPUT` before any handler runs. **REST:** an in-process fixed-window limiter (`apps/api/src/rate-limit.ts`, no dependency) charges every request to the client address (`PCA_RATE_LIMIT_PER_MINUTE`, default 600) as the first router middleware, and writes under a production to the verified principal (`PCA_WRITE_LIMIT_PER_MINUTE`, default 60) once the production scope is known; both answer `RATE_LIMITED` (new HTTP-only code, 429) with a `Retry-After` header and a next step. The HTTP server gets request/header timeouts (30 s / 15 s). **Gateway:** `maxPayloadBytes` (4 KiB; `ws` closes with 1009 before parsing), `maxConnectionsPerAddress` (8; the next upgrade is answered 429 before `handleUpgrade`, the slot freed on socket close), and `maxMessagesPerSecond` (20; a token bucket per connection, a client that runs dry is closed with 1008 and told why). **Retention:** the memory queue forgets its oldest COMPLETED/FAILED records past `maxRetainedJobs` (1000), with their idempotency keys; the memory job-run store forgets the oldest finished runs past `maxRunsPerProduction` (500), never one in flight.

Tests: contracts (`limits.test.ts`: each cap at and over the boundary); rate limiter unit (window turn, non-zero retry, sweep); API contract (burst → 429 with `Retry-After` and the code/message/next step, writes charged per principal while reads and another principal pass, 201 scene IDs → `INVALID_INPUT`); ws-gateway (oversized frame → 1009 and the client gone, N+1 connections from one address → 429 and the slot freed on close, a message burst → 1008 with the reason); memory-queue (finished jobs pruned oldest-first with their keys, queued work never pruned; job runs pruned per production with in-flight runs kept). `pnpm run verify` passes (9/9).

Docs: `MCP.md` §3 (maxima table); `README.md` env table; `ARCHITECTURE.md` §6 and §11; `TESTING.md`.

Not done here: charging model calls to quotas at the provider (TASK-929 adds cancellation), a trusted-proxy address (TASK-930), and the WS subscription-cap race (TASK-918, next).

## TASK-918 WebSocket subscription cap cannot be raced — TODO

**Goal**  
Concurrent subscribe messages cannot exceed the per-connection subscription limit.

**Context**  
SEC-013 (Medium) / AUD-022. `handleMessage` awaits `authorize` after reading `subscriptions.size`.

**Dependencies**  
None.

**Allowed scope**  
`packages/adapters/ws-gateway/src/index.ts` and its tests.

**Acceptance criteria**  
Messages processed serially per connection (or a slot reserved before the await and released on failure); the cap holds under a burst with delayed authorization.

**Tests**  
Burst of limit+N subscribes with a deliberately slow `authorize` leaves exactly `limit` subscriptions.

**Definition of Done**  
Acceptance met, verify green.

## TASK-919 Bind jobs to their proposal and requester — TODO

**Goal**  
A decision or apply can only continue the job that produced that exact proposal, from the expected stage, by an authorized principal.

**Context**  
SEC-008 (Medium) / AUD-012. Routes check only that `jobId` exists in the production.

**Dependencies**  
TASK-905 (atomic tracker), TASK-914 (principal).

**Allowed scope**  
`apps/api/src/app.ts`, `packages/application/src/jobs/handlers.ts`, job-run contract (record `proposalId`, `requestedBy`), docs.

**Acceptance criteria**  
Mismatched `proposalId`, wrong job type, or wrong stage → typed 409/404 without touching either job; the transition is a compare-and-set through `tracker.update`.

**Tests**  
API contract: reject with another proposal's job → 409; apply with a job at the wrong stage → 409; matching job advances.

**Definition of Done**  
Acceptance met, verify green.

## TASK-920 Model prose is untrusted presentation data — TODO

**Goal**  
Approval-critical claims (conflicts, warnings, version, digest, operations) come only from deterministic templates; free-form model narrative is labeled, separated, and cannot assert authorization or safety.

**Context**  
SEC-009 (Medium) / AUD-014. `explainImpact` returns an arbitrary string shown to the approver.

**Dependencies**  
None.

**Allowed scope**  
`packages/application` (explanation layer, model guard), `packages/contracts/src/explanation.ts`, `apps/web` confirmation view, docs.

**Acceptance criteria**  
Deterministic block always rendered first; model narrative is optional, marked as model-authored, and rejected by the guard if it contains authorization/safety assertions from a closed phrase list or references IDs not in the input.

**Tests**  
Adversarial prompt tests: "no conflicts" prose against a conflicting impact is dropped; narrative referencing an unknown ID is dropped; UI test shows the deterministic block without narrative.

**Definition of Done**  
Acceptance met, verify green, `DESIGN.md` updated.

## TASK-921 Restrictive file-store permissions — TODO

**Goal**  
The data directory is `0700`, data/temp/lock files `0600`, verified at startup.

**Context**  
SEC-010 (Medium) / AUD-017. Files are created with ambient umask.

**Dependencies**  
TASK-903.

**Allowed scope**  
`packages/adapters/file-store`, docs.

**Acceptance criteria**  
Explicit modes on mkdir/open; startup warns and tightens (or refuses, configurable) when an existing file is group/world-readable; symlinked data path refused.

**Tests**  
Integration: created file mode is `0600` (POSIX); loose existing file is tightened; symlink refused.

**Definition of Done**  
Acceptance met, verify green, `README.md` states the adapter is single-user.

## TASK-922 Raw change text: no duplication, retention policy — TODO

**Goal**  
`rawText` lives once on the change request; audit metadata carries a digest and length; retention/redaction is documented.

**Context**  
SEC-011 (Medium) / AUD-017.

**Dependencies**  
None.

**Allowed scope**  
`packages/application/src/use-cases/submit-change-request.ts`, audit contract, `apps/web` audit formatting, docs.

**Acceptance criteria**  
Audit event metadata has `rawTextDigest`, not `rawText`; UI warns not to paste secrets; high-confidence credential patterns are rejected at intake with a typed error.

**Tests**  
Unit: audit metadata shape; intake rejects a string containing an AWS-style key; web: warning text present.

**Definition of Done**  
Acceptance met, verify green, `SPEC.md` data policy section.

## TASK-923 Queue and JobRun state persist when Mongo is selected — TODO

**Goal**  
With `PCA_STORE=mongo`, job runs and queued work survive a restart.

**Context**  
AUD-009 (High). Queue and job-run repositories are process-local regardless of store.

**Dependencies**  
TASK-905.

**Allowed scope**  
`packages/adapters/mongo-store` (job-run repository with atomic `update`), a Mongo-backed queue adapter or documented SQS-deferred path, bootstrap wiring, docs.

**Acceptance criteria**  
Mongo job-run repository passes the shared job-run contract; restart with in-flight runs resumes or marks them failed with a clear reason; file/memory defaults unchanged.

**Tests**  
Integration (Mongo memory server): contract suite + restart scenario.

**Definition of Done**  
Acceptance met, verify green, `ARCHITECTURE.md` updated.

## TASK-924 Infrastructure errors are not copied into user-visible job state — TODO

**Goal**  
JobRun messages and API errors carry stable codes and safe text; raw driver/filesystem messages go only to structured operator logs with the correlation ID.

**Context**  
AUD-011 (Medium). `handlers.ts` writes `${error.code}: ${error.message}` into runs.

**Dependencies**  
None.

**Allowed scope**  
`packages/application/src/jobs`, API error mapping, logger, docs.

**Acceptance criteria**  
Infrastructure-class errors map to a fixed user message plus code; the original message is logged once with correlation ID; domain/validation errors keep their actionable text.

**Tests**  
Unit: a `STORE_CORRUPT` with a path in its message yields a run message without the path; log receives it.

**Definition of Done**  
Acceptance met, verify green.

## TASK-925 Upgrade the test toolchain past the mocker advisory — TODO

**Goal**  
Root `vitest` ≥ 4.1.11, lockfile regenerated, `pnpm audit` clean.

**Context**  
SEC-012 (Medium) / AUD-018. GHSA-82fw-gwwq-j7x9 in `@vitest/mocker`.

**Dependencies**  
None.

**Allowed scope**  
`package.json`, `pnpm-lock.yaml`, vitest configs, test fixes required by the major upgrade, CI audit step.

**Acceptance criteria**  
All suites pass on the new major; `pnpm audit` reports zero known vulnerabilities; CI runs `pnpm audit --audit-level=moderate`.

**Tests**  
Full verify.

**Definition of Done**  
Acceptance met, verify green.

## TASK-926 Mongo validates workflow documents on read and write — TODO

**Goal**  
Change requests, proposals, approvals, audit events, idempotency and job-run rows are parsed with their strict schemas; failures become `STORE_CORRUPT` without echoing document content.

**Context**  
SEC-015 (Low) / AUD-020. `fromRow<T>` casts.

**Dependencies**  
None.

**Allowed scope**  
`packages/adapters/mongo-store`, an idempotency-row schema in contracts.

**Acceptance criteria**  
Every read path parses; every write validates; malformed row → `STORE_CORRUPT` with collection + id only.

**Tests**  
Integration: insert a malformed approval directly; read yields `STORE_CORRUPT`, message has no field values.

**Definition of Done**  
Acceptance met, verify green.

## TASK-927 CI least privilege and pinned actions — TODO

**Goal**  
Actions pinned to full commit SHAs; explicit minimal `permissions`; Dependabot proposes SHA updates.

**Context**  
SEC-016 (Low) / AUD-019.

**Dependencies**  
None.

**Allowed scope**  
`.github/`.

**Acceptance criteria**  
No `@vN` action refs; top-level `permissions: contents: read`; `dependabot.yml` for github-actions and npm.

**Tests**  
CI green on the PR.

**Definition of Done**  
Acceptance met.

## TASK-928 Explicit HTTP security headers — TODO

**Goal**  
Central security-header policy: CSP tailored to the Angular build, `X-Content-Type-Options`, frame denial, Referrer-Policy, `Cache-Control: no-store` on API responses, HSTS when TLS is configured.

**Context**  
SEC-017 (Low) / AUD-024.

**Dependencies**  
None.

**Allowed scope**  
`apps/api` (own middleware or `helmet`), docs.

**Acceptance criteria**  
Headers present on API and served-UI responses; the UI still loads under the CSP (no `unsafe-inline` scripts).

**Tests**  
API contract asserts headers; e2e loads UI with CSP.

**Definition of Done**  
Acceptance met, verify green.

## TASK-929 Model calls carry an AbortSignal — TODO

**Goal**  
`ModelPort` methods accept a signal; the timeout guard aborts the provider request; adapters observe it.

**Context**  
SEC-014 (Low) / AUD-023.

**Dependencies**  
None.

**Allowed scope**  
`packages/application/src/ports/model.ts`, rule/Ollama/Bedrock adapters, docs.

**Acceptance criteria**  
Timeout aborts; job cancellation aborts; bounded provider concurrency.

**Tests**  
Unit: adapter observes abort on timeout; concurrency cap holds.

**Definition of Done**  
Acceptance met, verify green.

## TASK-930 Deployment baseline and Mongo connection policy — TODO

**Goal**  
A reproducible build artifact (container or `npm pack`) with a documented security baseline; Mongo connections require TLS and auth outside demo mode.

**Context**  
AUD-015 / AUD-016 (Medium).

**Dependencies**  
TASK-914, TASK-915.

**Allowed scope**  
`Dockerfile`/`.dockerignore` or pack script, bootstrap Mongo options, `docs/DEPLOYMENT.md`.

**Acceptance criteria**  
Non-demo Mongo URI without `tls=true`/credentials fails startup; the artifact runs the demo with documented env; baseline checklist in docs.

**Tests**  
Unit for URI policy; CI builds the artifact.

**Definition of Done**  
Acceptance met, verify green.

## TASK-931 Readiness and saturation health checks — TODO

**Goal**  
`/health` stays liveness; new `/ready` reports store reachability, queue depth, job-run backlog, lock state, and rate-limit rejections.

**Context**  
AUD-021 (Low).

**Dependencies**  
TASK-917.

**Allowed scope**  
`apps/api`, adapters expose cheap probes, docs.

**Acceptance criteria**  
`/ready` 503 when the store is unreachable; counters exposed as JSON; no secrets in output.

**Tests**  
API contract for both states.

**Definition of Done**  
Acceptance met, verify green.

## TASK-932 Full-entropy identifiers for operational records — TODO

**Goal**  
Proposal, approval, job, and audit IDs use untruncated random identifiers.

**Context**  
AUD-025 (Low).

**Dependencies**  
None.

**Allowed scope**  
ID generation in application/domain, `entityIdSchema` length if needed, fixtures.

**Acceptance criteria**  
≥122 bits of entropy per generated ID; existing fixtures unaffected.

**Tests**  
Unit on format/length.

**Definition of Done**  
Acceptance met, verify green.

## TASK-933 Angular program covers imported workspace sources — TODO

**Goal**  
`@pca/contracts` and `@pca/realtime-client` sources are part of the web TypeScript program (or consumed as built libraries), and the "not part of the compilation" warning fails CI.

**Context**  
Code review #17 (Medium).

**Dependencies**  
None.

**Allowed scope**  
`apps/web/tsconfig*.json`, `angular.json`, package builds, CI.

**Acceptance criteria**  
`pnpm build` emits no compilation-coverage warning; CI greps for it.

**Tests**  
Build in CI.

**Definition of Done**  
Acceptance met, verify green.

## TASK-934 Memory-store commits clone their inputs — TODO

**Goal**  
Mutating an object after `commit`/`applyProposalTransaction` does not change stored state.

**Context**  
Code review #18 (Low).

**Dependencies**  
None.

**Allowed scope**  
`packages/adapters/memory-store`, repository contract tests.

**Acceptance criteria**  
Contract test mutates inputs after commit and reads unchanged state in every adapter.

**Tests**  
Shared repository contract case.

**Definition of Done**  
Acceptance met, verify green.

## TASK-935 Queue idempotency scoped by production and job type — TODO

**Goal**  
Queue identity is `(productionId, type, idempotencyKey)`.

**Context**  
Code review #19 (Low).

**Dependencies**  
None.

**Allowed scope**  
`packages/adapters/memory-queue`, queue port docs.

**Acceptance criteria**  
Same key in two productions → two jobs; same tuple → `DUPLICATE`.

**Tests**  
Queue contract cases.

**Definition of Done**  
Acceptance met, verify green.

## TASK-936 One model-guard boundary — TODO

**Goal**  
`guardModelPort` is applied once at the composition root; use cases accept an already-guarded port.

**Context**  
Code review #20 (Low).

**Dependencies**  
None.

**Allowed scope**  
`packages/bootstrap`, `run-change-agent.ts`, `interpret-change.ts`, tests.

**Acceptance criteria**  
Exactly one guard layer per call, proven by a test counting validations; all composition roots pass through it.

**Tests**  
Unit counting guard invocations.

**Definition of Done**  
Acceptance met, verify green.

## TASK-937 Unused domain helpers are wired or removed — TODO

**Goal**  
`pendingOperations`, `staleCallSheetIdsForShootDays`, `checkVersionIncremented`, `idempotencyKeyForProposal` each have exactly one runtime consumer or are deleted with their tests.

**Context**  
Code review #21 (Low).

**Dependencies**  
TASK-911.

**Allowed scope**  
`packages/domain`, callers in application/web.

**Acceptance criteria**  
No exported helper without a non-test consumer; the UI derives its idempotency key from the domain helper.

**Tests**  
Existing tests adjusted.

**Definition of Done**  
Acceptance met, verify green.

---

# Parallelization guidance

After P0 contracts/domain stabilize:

```text
Agent A → Mongo/application core
Agent B → MCP read contracts/tests
Agent C → Angular shell/components
Agent D → local model/queue mocks
Agent E → Terraform/GitLab scaffolding
```

Avoid parallel edits to the same contract files. Shared-contract changes should be merged before dependent work.

# Priority rule

Do not implement optional OpenSearch, advanced optimization, or visual polish while any golden scenario or approval invariant is failing.
