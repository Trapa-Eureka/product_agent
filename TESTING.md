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
- idempotency helpers;
- explanation cards (DESIGN.md §3 and §4), pinned exactly for the golden
  scenarios so a wording change is a deliberate act.

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

### Fixture IDs

The IDs below are part of the test contract. Golden scenario tests, the seed
command, the demo script, and screenshots all name them, so changing one is a
breaking change. `packages/fixtures` publishes them as `DEMO_MOVIE_IDS` and the
integrity test asserts the whole set.

| Entity | ID |
|---|---|
| Production | `PROD-DEMO` |
| Cast | `CAST-SARAH`, `CAST-JOHN`, `CAST-MIKE` |
| Locations | `LOC-WAREHOUSE`, `LOC-CAFE`, `LOC-APARTMENT` |
| Scenes | `S07`, `S12`, `S18`, `S22` |
| Shoot days | `SD-2026-09-18`, `SD-2026-09-21`, `SD-2026-09-22` |
| Call sheets | `CS-2026-09-18`, `CS-2026-09-21`, `CS-2026-09-22` |
| Requirements | `REQ-001` crowbar on S07, `REQ-002` raincoat on S22 |
| Tasks | `T-001` to `T-004` |

Scheduling:

```text
Fri 2026-09-18  S07, S12   (Warehouse)
Mon 2026-09-21  S22        (Apartment)
Tue 2026-09-22  S18        (Cafe)
```

Every shoot day carries a published call sheet, so any scheduling change has a
real call sheet to invalidate rather than a silent no-op.

Two availability windows exist that no scenario touches: Mike is unavailable
2026-09-25 to 2026-09-26, and the Apartment is unavailable on 2026-09-22. They
keep the availability model exercised rather than uniformly empty.

### Required fixture conditions

- S07 and S12 are scheduled Friday.
- Sarah is initially available Friday.
- Monday is a valid alternative for S07/S12.
- Warehouse is initially available Friday.
- S18 has no red-car requirement initially.
- Friday has a call sheet linked to its shoot day.

Each condition is asserted on its own in the fixture integrity test, so an edit
that quietly breaks a golden scenario fails with the name of the condition it
broke rather than deep inside a scenario test.

The fixture is a factory, not a shared constant: every caller gets a fresh copy,
so a test that mutates its production cannot corrupt the next one. It also
starts out fully valid, because a fixture that begins broken makes every later
failure ambiguous.

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

They live in `packages/test-support` as `describeGoldenScenarios` and run
unchanged against every repository adapter: the memory store in the unit suite
and the file store in the integration suite. Each bullet above is one named
test, in its own words, so a regression names the promise it broke. The
pipeline runs once per scenario; the assertions read the artefacts of each
stage rather than re-running it, so a failure in one bullet does not hide the
others. Every scenario also checks that the audit trail reads submitted,
proposed, approved, applied, verified, with no chain-of-thought in it.

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

`createFakeModelAdapter` in `packages/test-support` answers the three golden
sentences and can be told to misbehave (`malformed`, `hallucinate`, `throw`,
`hang`). Those tests exercise `guardModelPort`, which every adapter sits
behind, so a real provider cannot get past what the fake cannot.

## 6. Queue mocking

Create an in-memory/fake queue implementing the same application port as SQS.

Test:
- enqueue;
- retry;
- duplicate message/idempotency;
- terminal failure;
- event state transitions.

AWS-specific adapter tests can be separate and optional in normal local verification.

## 6a. MongoDB in tests

The Mongo adapter is exercised with `mongodb-memory-server` in replica-set
mode, so multi-document transactions are real. No server is installed and no
account is needed. The first run downloads the mongod binary (about 66 MB, once,
cached under the user's home); that download is the only network access in the
test suite. One replica set starts per test file and each test gets its own
database, so isolation costs nothing after start-up.

Both the repository contract suite and the golden scenario suite run against
Mongo in the integration suite, unchanged from the memory and file adapters.

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

These live in the registry-wide contract suite in `apps/mcp-server/test`,
alongside the TASK-207 sweeps, so the security boundary is judged against the
server that ships. "Prompt text cannot bypass authorization" is tested
literally: an instruction-shaped query is just a search with no candidates, and
an ID with a smuggled second production fails the ID pattern before any handler
runs.

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
