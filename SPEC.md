# Product Specification

## 1. Product

**AI Production Change Agent — MCP-powered production workflow assistant**

The product helps a production coordinator understand and safely respond to changes that propagate through connected production data.

## 2. Problem

Production plans contain dependencies. Scenes require cast, locations, props, and other elements. Schedules assign scenes to shoot days. Call sheets and operational tasks are derived from those plans.

When one fact changes, a coordinator must answer:

- What is affected?
- Is the current plan now invalid?
- What can be moved or replaced?
- What secondary work must be updated?
- Can the change be applied safely?

A general chat model is not a reliable dependency engine. This product combines natural-language interaction with deterministic domain analysis and controlled MCP actions.

## 3. Primary user

MVP user: **production coordinator / production manager**.

The user can:
- report a change in plain language;
- inspect the exact impact;
- compare proposed remedies;
- see conflicts/warnings;
- approve or reject a proposal;
- inspect the verified result and audit trail.

## 4. Functional requirements

### FR-1 Natural-language change intake

The system accepts statements such as:

- `Sarah cannot shoot Friday.`
- `The warehouse is unavailable on September 18.`
- `Scene 18 now needs a red car.`

The AI layer converts the statement into a typed change request. Entity resolution must be confirmed against real domain data.

Intake is the first deterministic checkpoint after the AI layer. Whatever interpreted the sentence, every ID in the typed change is confirmed against the production's real data before anything is persisted: an unknown or misattributed entity is refused with `ENTITY_NOT_FOUND` and the name of the lookup tool to use. The raw sentence is stored verbatim beside the typed change, so the audit trail shows what the user said and not only what the system made of it.

### FR-2 Impact analysis

For a resolved change, deterministic application logic identifies affected:
- scenes;
- cast;
- locations;
- scene requirements;
- schedule entries/shoot days;
- call sheets;
- tasks.

The result must explain *why* each item is affected.

### FR-3 Simulation

Before mutation, the system can simulate candidate changes against a snapshot/version of current production state.

Simulation must not persist business changes.

### FR-4 Validation

A proposal is invalid when it violates domain invariants, including:
- cast unavailable on assigned shoot day;
- location unavailable on assigned shoot day;
- required cast/location missing from a scheduled scene;
- conflicting schedule assignments defined by the MVP;
- proposal generated from stale production state.

### FR-5 Proposal

A proposal contains:
- source change;
- affected entities;
- proposed operations;
- warnings;
- validation result;
- production-state version;
- human-readable explanation.

### FR-6 Approval

Consequential writes require explicit human approval.

Approval must be bound to:
- proposal ID;
- proposal version/hash;
- production-state version;
- approving user;
- timestamp.

If the underlying state changes after simulation, the proposal must be revalidated before mutation.

### FR-7 Mutation

Approved proposals are executed only through allow-listed MCP write tools/application commands.

No free-form database mutation is exposed to the model.

### FR-8 Verification

After mutation, the system re-reads affected entities and validates expected postconditions.

A failed verification is surfaced clearly and recorded.

### FR-9 Audit

Record:
- incoming change;
- analysis;
- proposal;
- approval/rejection;
- executed operations;
- result;
- errors.

## 5. MVP scenarios

### Scenario A — Cast unavailable

Input:

`Sarah cannot shoot Friday.`

Expected behavior:
1. Resolve Sarah and Friday.
2. Find Friday schedule entries containing Sarah.
3. Find affected scenes and dependent call sheet/tasks.
4. Mark the existing plan as conflicted.
5. Generate one or more candidate responses, e.g. move affected scenes to a compatible shoot day.
6. Simulate and validate.
7. Show impact.
8. Require approval.
9. Apply approved schedule changes.
10. Verify no selected scene remains scheduled when Sarah is unavailable.

### Scenario B — Location unavailable

Input:

`The warehouse is unavailable Friday.`

Expected behavior:
1. Resolve the warehouse and date.
2. Find scenes scheduled at that location.
3. Find cast, schedule, call-sheet, and task effects.
4. Generate candidates such as moving affected scenes to a compatible day.
5. Simulate, validate, propose, approve, apply, verify.

### Scenario C — Scene requirement changed

Input:

`Scene 18 now needs a red car.`

Expected behavior:
1. Resolve Scene 18.
2. Parse `red car` as a proposed PROP requirement.
3. Detect whether an equivalent requirement already exists.
4. Simulate adding it.
5. Identify affected tasks/call-sheet preparation and shoot day.
6. Propose requirement + procurement/preparation task.
7. Require approval.
8. Apply and verify.

## 6. AI requirements

The AI layer is allowed to:
- classify user intent;
- extract candidate entities/dates/requirements;
- call read-only MCP tools;
- request deterministic analysis/simulation;
- explain results;
- rank already-valid alternatives;
- prepare a proposed action plan.

The AI layer is not allowed to:
- invent entity IDs;
- decide authorization;
- bypass approval;
- execute arbitrary database queries;
- treat generated reasoning as authoritative dependency data;
- silently apply a consequential change.

## 7. Realtime requirements

The UI should receive live status for long-running analysis/application jobs:

```text
received
resolving
analyzing
simulating
validating
awaiting_approval
applying
verifying
completed
failed
```

WebSocket is preferred for the portfolio implementation.

## 8. Non-functional requirements

### Reliability
- MCP writes are idempotent where practical.
- Retries must not duplicate tasks or schedule operations.
- stale proposals are rejected/revalidated.

### Security
- least-privilege tool access;
- server-side authorization;
- input validation;
- no secrets in prompts/logs;
- audit logging.

### Testability
- no live AWS dependency for normal local tests;
- deterministic fixture production;
- deterministic mock model responses for acceptance tests.

### Observability
Structured logs should include:
- request/change ID;
- proposal ID;
- tool name;
- duration;
- result/error category.

## 9. Out of scope for MVP

- Complete screenplay editor
- Full stripboard optimizer
- Full industry scheduling rules
- Billing
- Multi-company enterprise permissions
- Image/storyboard generation
- Mobile applications
- Automatic external email/SMS delivery
- Autonomous approval

## 10. MVP acceptance

The MVP is accepted when all three scenarios can run end-to-end locally and:
- affected entities are deterministically correct;
- no mutation occurs before approval;
- stale/invalid proposals cannot execute;
- post-write verification runs;
- contract/integration/E2E tests pass;
- no live AWS account is required for the test suite.
