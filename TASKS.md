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

## TASK-110 REST API

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

## TASK-203 Analysis tools

Implement:

- analyze_change_impact
- generate_schedule_candidates
- simulate_proposal
- validate_proposal

## TASK-204 Proposal tools

Implement create/get proposal.

## TASK-205 Safe write tool

Implement `apply_approved_proposal`.

**Critical acceptance**
No approval = no mutation.

## TASK-206 Verification tool

Implement `verify_applied_proposal`.

## TASK-207 MCP contract suite

Test all success/error/security cases in `MCP.md`.

---

# P3 — AI Orchestration

## TASK-301 Model port

Define provider-independent model interface.

## TASK-302 Fake model adapter + rule-based interpreter adapter

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

## TASK-304 Change interpreter

Natural language → schema-validated typed change candidate → entity resolution.

## TASK-305 Agent orchestration

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

## TASK-306 Explanation layer

Produce concise user-facing explanation from structured deterministic results.

---

# P4 — Async / Realtime

## TASK-401 Queue port + fake queue

Deterministic local queue.

## TASK-402 SQS adapter — DEFERRED (paid)

Implement enqueue/consume/retry/DLQ-oriented behavior.

**Free scope**  
None executed. The in-memory queue (TASK-401) is the only queue adapter until an AWS account exists.

## TASK-403 Job state machine

Implement documented job stages.

## TASK-404 WebSocket gateway

Publish job/proposal status.

## TASK-405 Reconnect/recovery

Client can recover canonical state after socket loss.

---

# P5 — Angular UI

## TASK-501 Angular shell

Production navigation + change workspace.

## TASK-502 Change input/resolution

Input, ambiguity resolution, detected-change card.

## TASK-503 Impact view

Grouped impacts with deterministic `why`.

## TASK-504 Proposal view

Operations, warnings, candidate comparison.

## TASK-505 Approval flow

Reject / Approve & Apply with explicit confirmation.

## TASK-506 Realtime progress

Render job stages.

## TASK-507 Schedule view

Show before/after state clearly.

## TASK-508 Audit view

Structured action timeline without chain-of-thought.

---

# P6 — Testing / CI

## TASK-601 Golden scenario tests — DONE

Implement GOLDEN-1/2/3.

**Status**  
Complete, pulled forward from P6 as the regression baseline for everything after P1. `describeGoldenScenarios` in `packages/test-support` runs the full pipeline (intake, analysis, candidates, simulation, proposal, refused apply, approval, apply, replay, re-simulation, verification) once per scenario and asserts every TESTING.md §4 bullet by name, on both the memory store and the file store.

## TASK-602 Failure injection

Implement stale version, provider failure, queue retry, partial failure cases.

## TASK-603 Security tests

Implement approval/cross-production/schema/tool-boundary tests.

## TASK-604 Playwright E2E

Three core scenarios.

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
