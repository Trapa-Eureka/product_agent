# Testing Strategy

## 1. Goal

Testing is an agent feedback system, not a final QA phase.

A coding agent should be able to make a bounded change, run deterministic checks locally, diagnose failures from useful messages, and correct itself without live cloud access or repeated human intervention.

## 2. Test pyramid

### Unit tests
Fast tests for:
- domain invariants;
- dependency traversal;
- availability;
- candidate generation;
- proposal validation;
- proposal digest/version rules;
- idempotency helpers.

### Integration tests
Test:
- application use cases + Mongo test database/adaptor;
- queue port/adaptor;
- approval/application flow;
- audit creation.

### MCP contract tests
Test every tool schema and safety boundary.

### API tests
Test REST endpoints and auth/context boundaries.

### E2E
Angular → API → agent/mock → MCP/application → DB → UI.

Keep E2E focused on the three core demo scenarios.

## 3. Deterministic fixture: Demo Movie

Create one canonical fixture.

Example:

```text
Production: Demo Movie
Timezone: Asia/Manila

Cast:
Sarah
John
Mike

Locations:
Warehouse
Cafe
Apartment

Shoot Days:
Fri 2026-09-18
Mon 2026-09-21
Tue 2026-09-22

Scenes:
S07 — Warehouse — Sarah, John
S12 — Warehouse — Sarah
S18 — Cafe — Mike
S22 — Apartment — John
```

Choose exact fixture IDs and keep them stable.

### Required fixture conditions

- S07 and S12 are scheduled Friday.
- Sarah is initially available Friday.
- Monday is a valid alternative for S07/S12.
- Warehouse is initially available Friday.
- S18 has no red-car requirement initially.
- Friday has a call sheet linked to its shoot day.

## 4. Golden scenario tests

### GOLDEN-1 Sarah unavailable Friday

After creating `CAST_UNAVAILABLE`:
- affected scenes = S07, S12;
- Friday shoot day affected;
- Friday call sheet affected;
- analysis contains blocking cast conflict;
- a valid Monday candidate exists;
- no mutation before approval;
- after approved move, S07/S12 are not on Friday;
- verification passes.

### GOLDEN-2 Warehouse unavailable Friday

Expected:
- S07/S12 affected;
- Friday schedule affected;
- cast implications include Sarah/John;
- call sheet affected;
- valid candidate produced;
- approval required;
- post-write verification passes.

### GOLDEN-3 Scene 18 needs red car

Expected:
- S18 affected;
- new requirement proposed;
- preparation task proposed;
- shoot-day/call-sheet impact surfaced;
- duplicate replay does not create duplicate requirement/task;
- approval required;
- verification passes.

These tests are the project's most important acceptance signal.

## 5. Model mocking

Normal automated tests must not call Bedrock.

Create `FakeModelAdapter` with deterministic outputs for known prompts/inputs.

Also test malformed model output:
- invalid JSON;
- unknown entity;
- wrong enum;
- hallucinated ID;
- timeout;
- provider error.

All model output is schema-validated.

## 6. Queue mocking

Create an in-memory/fake queue implementing the same application port as SQS.

Test:
- enqueue;
- retry;
- duplicate message/idempotency;
- terminal failure;
- event state transitions.

AWS-specific adapter tests can be separate and optional in normal local verification.

## 7. Search mocking

If OpenSearch is added:
- keep search behind a port;
- provide deterministic fake results;
- do not require OpenSearch for core dependency tests.

## 8. Failure injection

Agents improve faster when failures are explicit.

Add tests for:
- Mongo repository failure;
- stale production version;
- approval mismatch;
- queue retry;
- WebSocket disconnect/reconnect;
- partial operation failure;
- verification failure.

Error messages should identify the failing boundary and correlation ID.

## 9. Security tests

At minimum:
- cross-production entity access rejected;
- write without approval rejected;
- tampered proposal digest rejected;
- stale approval rejected;
- invalid schema rejected;
- arbitrary tool/operation name rejected;
- prompt text cannot bypass authorization.

## 10. Static feedback

Run:
- TypeScript strict mode;
- ESLint;
- formatting check if configured;
- dependency/build checks.

Prefer compiler-visible contracts over implicit runtime assumptions.

## 11. Target commands

```bash
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run test:contract
npm run test:e2e
npm run verify
```

Recommended `verify`:

```text
typecheck
→ lint
→ unit
→ integration
→ MCP contract
→ build
→ focused E2E
```

## 12. CI

GitLab CI should run deterministic verification on merge requests.

Suggested stages:

```text
install
quality
unit
integration
contract
build
e2e
```

Cache dependencies, but never make correctness depend on cache state.

## 13. Definition of done

A feature is done only when:
- acceptance criteria exist;
- tests demonstrate them;
- relevant negative cases exist;
- local verification passes;
- no live AWS service is required for the normal test path;
- docs/contracts are updated if behavior changed.

The objective is to make autonomous agent work **self-correcting**, not merely code-generating.
