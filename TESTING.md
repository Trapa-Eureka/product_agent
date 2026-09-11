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

Implementation (TASK-804, ARCHITECTURE.md §16): a `recordingLogger` (a plain
object collecting `{level, event, fields}` lines instead of printing them,
the same tiny shape repeated locally in each file rather than shared —
there is nothing to share beyond three lines) tests every new timing seam:
`infrastructure-error.test.ts` asserts `guardPort`/`guardRepositories` log a
`db_call` line with a numeric `durationMs` on success and on a thrown
failure alike, and stay silent without a logger; `model-port.test.ts` the
same for `guardModelPort`'s `model_call` lines, including a timeout;
`analyze-change-impact.test.ts` asserts `dependency_analysis` carries the
correlation ID the call was given and does not fire when the change is
refused before analysis runs; `run-change-agent.test.ts` asserts both kinds
of line appear through the fused loop; `bootstrap.test.ts` asserts
`createRepositories`/`createModel` thread a logger through to a real
file/memory store and the rule model. One MCP contract test
(`analysis-tools.contract.test.ts`) drives `analyze_change_impact` through a
real client and checks `dependency_analysis` appears alongside the
`tool_call` line every tool already produces (MCP.md §2) — two different
events, not one overloaded with both meanings.

Angular specs (`apps/web/src/**/*.spec.ts`) run through `ng test` (vitest 4,
jsdom) as the verify step `test:web`, separate from the root vitest suites,
which exclude them. They cover the shell's rendering, the REST client's
error mapping, and the realtime service's signals with a fake socket.

The change workspace's specs (TASK-502) add: `typed-change-format`, pure
tests for all four change kinds and both golden date shapes; a fake
`RealtimeService` whose `view` is a real Angular signal, used to drive
`ChangeSubmissionService` through submit, an ApiError, resuming a job at
`resolving`, and a live event that must be re-read over REST before a
change-request fetch follows; and component-level renders of `ChangeInput`,
`AmbiguityResolution`, and `DetectedChangeCard` against a fake submission
service, including that two ambiguity options sharing a label still render
a distinguishing detail each.

TASK-503 extends the same cascade test through a third fetch
(`POST .../analysis/explanation`, triggered once the change request is
known) and adds `ImpactPanel`'s own spec: BLOCKING/AFFECTED/WHY in the
server's exact group order, empty groups omitted, no BLOCKING section at all
when nothing blocks, and a plain message when nothing is affected.

TASK-504 adds `ProposalCard` (headline, `+`/`!` effects each with the right
tone, operations, an optional narrative) and `CandidateComparisonPanel`
(the ranked list with the top rank marked chosen, warnings on a candidate,
a rejected day's reasons, the "Not considered" section omitted when nothing
was rejected). Because `explanation`/`candidateComparison` ride on the
`JobRun` rather than a fetch, their tests live at the job-handler and
stage-machine level: GOLDEN-1 asserts the run carries the exact proposal
headline and the ranked/rejected shoot days once it reaches
`awaiting_approval`; GOLDEN-3 asserts a non-scheduling change carries no
candidate comparison at all.

TASK-505 tests the approval flow at three levels: `ChangeSubmissionService`
gains `reject` (decides with the job's ID, then re-reads the job so
completion shows without waiting on a live event) and `approveAndApply`
(decides, then applies with `expectedProductionVersion` from the decision's
own response, not a guess), both against `HttpTestingController`; a new API
contract test rejects a real job through the whole stack and asserts it
reaches `completed`, including that a replayed rejection does not error;
and `ChangeWorkspace`'s own spec (the only workspace-level spec so far,
justified because the wiring — the disabled/enabled gate, the confirmation
opening, and resetting a stale "confirming" flag for a different job — lives
in the component itself rather than a leaf) overrides the component's own
`ChangeSubmissionService` provider with `TestBed.overrideComponent` to
verify it without HTTP.

TASK-506 adds `job-progress-format`, pure tests of `buildJobProgress` for a
fresh job, the happy path partway to `awaiting_approval` (with `resolving`
correctly left `pending`, not `done`, because that run skipped it), a fully
completed pipeline (every stage `done`), a rejected job (`applying`/
`verifying` still `pending` though the job itself is `completed`, and
nothing `active`), and a `failed` job (only the failed stage and its
message, not the eight-row list); a `JobProgressTimeline` render spec
checking the ✓/●/○ text and `data-status` attribute per row and the
failure-only view; and one more assertion in `ChangeWorkspace`'s own spec
that the tracked job reaches the panel.

TASK-507 and TASK-508 add two more pure-formatter-plus-component pairs.
`schedule-format` tests `buildScheduleRows`: shoot days sorted earliest
first regardless of input order, a resolved scene labelled by number,
title, location, and required cast, a scene with no title labelled by
number alone, an unresolved scene shown honestly by its ID rather than
dropped, and an empty day rendered as an empty list, not an error;
`SchedulePage`'s own spec drives it through a fake `ProductionApi`,
resolving two shoot days' scenes and rendering them earliest first, and
a day with no scenes showing a plain message. `audit-format` tests
`describeAuditEvent` against every action the codebase actually writes
(`CHANGE_REQUEST_SUBMITTED` through `PROPOSAL_VERIFICATION_FAILED`, plus an
unknown action falling back to a humanized line) and `formatAuditTime`
against two timezones; `AuditPage`'s own spec asserts the newest-first API
response renders oldest first, with each line's time converted to the
production's timezone. `ProductionApi` gains matching request/response
tests for `getSchedule` and `getScene`.

### Integration tests
Test:
- application use cases + Mongo test database/adaptor;
- queue port/adaptor;
- approval/application flow;
- audit creation.

Implementation (TASK-801): `FileStore.resetProduction`'s own tests live here
(real filesystem, `packages/adapters/file-store/test/file-store.integration.test.ts`)
— seed a production plus one change request/proposal/approval/audit
event/idempotency record, call it again, and check the production's state
came back fresh while every one of those is gone; a second test checks
another production's records survive untouched. `resetDemoMovie`
(`@pca/bootstrap`) — the environment-wired, `PCA_STORAGE`-checked entry
point `scripts/seed.ts` calls — is tested in the unit suite alongside the
rest of `packages/bootstrap`'s selection functions, the same place its
existing file-store tests already run real (temp-directory) file I/O.

### MCP contract tests
Test every tool schema and safety boundary.

Model prose (TASK-920): `packages/application/test/model-port.test.ts`
drives adversarial but schema-valid narratives and ranking reasons through
`guardModelPort` — each authorization/safety phrase in the closed list, "no
conflicts" against a conflicting finding (allowed when there is none), an
ID the model was not shown (allowed when it was), and a ranking reason
claiming "no warnings" for a day that has one — and asserts each is
`UNGROUNDED_OUTPUT`; `apps/web` asserts the card renders the deterministic
block first and the narrative last under its label, or not at all.

### API tests
Test REST endpoints and auth/context boundaries.

Implementation (TASK-110): `apps/api/test/*.contract.test.ts`, run in the
contract suite with real HTTP against a server on an ephemeral port: context
boundaries (allow-list, correlation ID, malformed input, unknown routes,
cross-production smuggling), identity (TASK-914: 401 without or with a
forged/expired token, a caller-supplied `X-Actor-Id` ignored, a token whose
grant lacks the production, viewer/requester/approver role gates, maker-
checker, the demo-session route present only in demo mode, the WebSocket
upgrade refused without a token; TASK-916: a foreign or `null` Origin
refused with 403 before any socket, the server's own and a listed origin
accepted, a query-string token without an Origin refused while a header
token may omit it; TASK-917: a burst over the per-client quota → 429 with
`Retry-After`, writes charged per principal while reads pass, an array over
its documented maximum → `INVALID_INPUT`; TASK-919: a decision or apply
through another proposal's job → `JOB_MISMATCH` with nothing changed, a
replayed apply answered with the run and not enqueued twice, a job resumed
by another principal → 403 and a job not at `resolving` → `JOB_MISMATCH`;
TASK-922: a sentence carrying a credential refused on both intake routes
naming the kind only, and the audit event carrying a digest, a length, and
the engine's summary but never the sentence), reads, GOLDEN-1 driven through REST alone,
the stable error codes, changes as jobs with recovery, ambiguity resumed on
the same job, and the WebSocket gateway on the same server.

### E2E
Angular → API → agent/mock → MCP/application → DB → UI.

Keep E2E focused on the three core demo scenarios.

Implementation (TASK-604): three Playwright specs under `e2e/`, one per
golden scenario, each driving a real Chromium against the real stack —
Angular dev server, the REST API, `createRuleModelAdapter` (the free "agent"
`main.ts` itself defaults to, not a mock), the application/domain engine,
and a memory store — the "agent" and "DB" above, kept real rather than
mocked, because that is what makes this suite worth having on top of the
unit/integration layers, which already exercise the pipeline against a
`FakeModelAdapter` (TESTING.md §5). Each spec gets its own copy of the Demo
Movie fixture (`PROD-E2E-1/2/3`, seeded by `apps/api/e2e/server.ts`, the
process `playwright.config.ts`'s `webServer` starts) so the three can run in
parallel without one's mutation — Friday's scenes moving elsewhere —
breaking another's preconditions. A spec follows the DESIGN.md §10 demo
story exactly: submit the golden sentence (clicking its own example
button), read the impact/proposal panels, approve through the §5
confirmation, wait for the §6 progress timeline to show all eight steps
done, then check the Schedule and Audit nav views for the result.

One real finding this suite surfaced that the fixed-model unit/integration
suites cannot: GOLDEN-1/2's real ranking (fewest new warnings) picks Tuesday
over Monday for the demo fixture, not the Monday the GOLDEN-1 unit test's
own model is scripted to pick — a legitimate difference in model
implementation, not a bug, so the specs assert the move and the result
(scenes off Friday) rather than pinning a specific target day.

One-time local setup Playwright itself does not do: `pnpm exec playwright
install chromium` (downloads the browser binary; not run by `pnpm install`).

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

The job stage machine (TASK-403) is tested at three levels: the pure graph
(every allowed edge, every refused one, and that `applying` is reachable only
from `awaiting_approval`), the tracker (persist and publish together), and the
handlers end to end through the in-process queue against the Demo Movie,
including redelivery after a transient failure and a queue that gives up.

The WebSocket gateway (TASK-404) is tested with real `ws` clients against a
gateway on an ephemeral port: greeting, per-production delivery, proposal
notifications, tracker-to-socket order, unsubscribe, ping, malformed
messages, an unauthorized production, the subscription cap, disconnect,
shutdown close code, heartbeats, and attaching to an existing HTTP server.
The notification sources are tested in the application package: the hub,
job-event forwarding, and the proposal-save decorator, including that a save
that throws publishes nothing.

Reconnect and recovery (TASK-405) are tested with a fake socket and a manual
timer (subscribe, acknowledge, recover; held notifications; unknown job or
proposal; backoff; close), and once end to end: a real gateway is closed
under a connected client and restarted on the same port while a job moves
on, and the client comes back with the canonical state and live events.

AWS-specific adapter tests can be separate and optional in normal local verification.

Implementation (TASK-401): `describeQueueContract` in `@pca/test-support` is
the suite above, run today against `@pca/memory-queue`. Tests hold time still
with `manualScheduler`, so a retry backoff is an assertion about a recorded
delay rather than a sleep, and `drain()` delivers every runnable job, waiting
retries included, for a deterministic end state.

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

Implementation (TASK-602): the suite is
`packages/application/test/failure-injection.test.ts`, with the Mongo case as
an integration test in the Mongo adapter and disconnect/reconnect in the
realtime client's suites. Faults are scripted with `withFault` /
`withRepositoryFault` from `@pca/test-support` (always, or the first N calls);
`withFault` targets any method directly, `withRepositoryFault` targets one
nested under a repository. A thrown infrastructure fault is an
`InfrastructureError` naming `<adapter>.<repository>.<method>` for a nested
repository call, or `<adapter>.<method>` for a `RepositorySet` member that is
itself a method — `applyProposalTransaction` (TASK-901) — since
`guardRepositories` guards both shapes the same way. The queue's retry
reason, the job run's failure message, the audit trail, and the MCP
`INTERNAL_ERROR` carry the boundary and the correlation ID, and never the raw
driver message or prompt text.

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
npm run test:web
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

Implementation (TASK-605): the repository is hosted on GitHub, so
`.github/workflows/ci.yml` is the pipeline that actually runs, on every push
to `main` and every pull request. It is one job that runs `pnpm run verify`
— the same completion gate a contributor runs locally — rather than a
second, hand-kept-in-sync copy of `scripts/verify.mjs`'s step order and
pass/fail logic. No external service: the integration suite's Mongo is
`mongodb-memory-server` (an in-process binary), and the E2E suite's servers
are started and torn down by Playwright itself against a memory store — the
one extra step CI needs beyond `pnpm install` is `pnpm exec playwright
install --with-deps chromium` (TASK-604). `.gitlab-ci.yml` is documentation
only — it never runs here — and spells the same pipeline out as separate
staged jobs (the suggested list above, plus `web` for the Angular specs,
which has no home in it otherwise), for anyone comparing the two systems.

## 13. Definition of done

A feature is done only when:
- acceptance criteria exist;
- tests demonstrate them;
- relevant negative cases exist;
- local verification passes;
- no live AWS service is required for the normal test path;
- docs/contracts are updated if behavior changed.

The objective is to make autonomous agent work **self-correcting**, not merely code-generating.
