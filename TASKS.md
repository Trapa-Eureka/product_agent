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

## TASK-605 CI

Run deterministic `verify`.

**Free scope**  
The repository is hosted on GitHub, so GitHub Actions is the executed pipeline. Author `.gitlab-ci.yml` with the same stages for portfolio purposes; it runs only if the repo is mirrored to GitLab.com.

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

## TASK-801 Seed/reset command

One command restores Demo Movie.

## TASK-802 Architecture diagram

Create original diagram from `ARCHITECTURE.md`.

## TASK-803 Demo script

2–4 minute demo based on `DESIGN.md`.

## TASK-804 Performance instrumentation

Add correlation IDs/timings for model, MCP, DB, and analysis.

## TASK-805 README finalization

Screenshots, setup, architecture, trade-offs, limitations.

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
- the file store is single-process; multi-writer deployments should switch to Mongo.

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
