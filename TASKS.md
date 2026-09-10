# Implementation Backlog

This backlog is designed for bounded agent execution and parallel work.

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

## TASK-001 Monorepo foundation

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

## TASK-002 Shared contracts

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

## TASK-003 Domain model

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

## TASK-004 Demo Movie fixtures

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

## TASK-101 Repository ports

Define repository interfaces required by application use cases.

## TASK-102 MongoDB adapters

Implement MongoDB repositories and indexes.

**Acceptance**
Adapters satisfy repository contracts and production isolation.

## TASK-103 Change intake use case

Persist raw/typed change request and correlation ID.

## TASK-104 Dependency impact engine

Implement deterministic impact traversal.

**Acceptance**
Golden scenario impact sets are exact.

## TASK-105 Candidate schedule generator

Implement simple valid-day candidate generation.

**Non-goal**
Do not build a general optimization solver.

## TASK-106 Proposal simulation/validation

Create side-effect-free simulation and proposal validation.

## TASK-107 Approval model

Implement proposal digest, approval binding, stale-version checks.

## TASK-108 Apply proposal

Implement high-level approved proposal execution with idempotency and version increment.

## TASK-109 Verification

Implement post-write verification checks.

---

# P2 — MCP

## TASK-201 MCP server foundation

Register server, schemas, context, logging.

## TASK-202 Read tools

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

## TASK-302 Fake model adapter

Implement deterministic local behavior for the three golden scenarios.

## TASK-303 Bedrock adapter

Implement structured-output model calls behind the port.

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

## TASK-402 SQS adapter

Implement enqueue/consume/retry/DLQ-oriented behavior.

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

## TASK-601 Golden scenario tests

Implement GOLDEN-1/2/3.

## TASK-602 Failure injection

Implement stale version, provider failure, queue retry, partial failure cases.

## TASK-603 Security tests

Implement approval/cross-production/schema/tool-boundary tests.

## TASK-604 Playwright E2E

Three core scenarios.

## TASK-605 GitLab CI

Run deterministic `verify`.

---

# P7 — AWS / Infrastructure

## TASK-701 Terraform foundation

Provider/backend conventions, variables, outputs, validation.

## TASK-702 SQS + DLQ

Terraform queue resources and least-privilege IAM.

## TASK-703 Bedrock permissions/config

Minimal required configuration and documentation.

## TASK-704 OpenSearch spike — optional

Only after core MVP works.

Evaluate production-document search/RAG separately from dependency analysis.

## TASK-705 Deployment design

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
