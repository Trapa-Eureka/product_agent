# Comprehensive Code Review

- Review date: 2026-09-11 (Asia/Manila)
- Reviewed revision: `c6ddb4ee9b4cbc55e826fd2703dbe003a2a3b626`
- Scope: the entire repository, including application/domain/contracts, adapters, API/MCP servers, Angular client, scripts, tests, and project configuration
- Focus: correctness, simplification, efficiency, error handling, edge cases, type safety, maintainability, dead/redundant code, and concurrency

## Findings

### Critical

#### 1. A production mutation and its idempotency/status/audit records are not committed atomically

- **File:** `packages/application/src/use-cases/apply-approved-proposal.ts`
- **Lines:** 249-290
- **Problem:** The production commit occurs first, followed by three independent writes for the idempotency record, proposal status, and audit event. A failure after line 255 leaves the business mutation committed while some or all bookkeeping remains absent. A replay then sees the advanced production version before it sees an idempotency record and returns `PRODUCTION_VERSION_MISMATCH` instead of recovering the successful result.
- **Why it matters:** This is the central consequential-write path. A transient repository error can produce a changed production that the API reports as failed, an `APPROVED` proposal whose operations are already present, and no trustworthy apply audit. The documented verification path can detect part of the inconsistency but cannot repair it, and normal retries are permanently blocked. This was reproduced by injecting a one-time failure in `idempotency.save`: the production advanced to version 2, while the retry failed against expected version 1.
- **Recommended fix:** Add a repository-level `applyProposalTransaction`/unit-of-work operation that atomically performs the version-checked production mutation, idempotency insert, proposal transition, and audit append. Implement it with a Mongo transaction and one file-store read-modify-write. If a cross-store transaction cannot be introduced immediately, persist a durable operation record before commit and make retry/recovery reconcile a committed post-state into the missing records. Add failure-injection tests at every boundary after the production commit.

#### 2. Concurrent approval and rejection requests can both succeed and persist contradictory state

- **Files:** `packages/application/src/use-cases/decide-proposal.ts`; `packages/adapters/mongo-store/src/index.ts`
- **Lines:** `decide-proposal.ts` 72-87, 141-177; `mongo-store/src/index.ts` 281-286, 382-401
- **Problem:** Decision finality is implemented as a read-then-write sequence without compare-and-set or a transaction. The Mongo index on `(productionId, proposalId)` is non-unique, and approvals are keyed by generated approval ID, so two callers can both observe “no decision” and write opposite decisions. Proposal status is another independent last-writer-wins update.
- **Why it matters:** The safety boundary can contain both `APPROVE` and `REJECT` records for one proposal, while the proposal status reflects whichever write happened last. `findByProposalId` then selects an arbitrary/ID-sorted record. In a direct concurrent reproduction both calls returned success; the stored proposal was `APPROVED` while `findByProposalId` returned the `REJECT` approval.
- **Recommended fix:** Make “record first decision” an atomic repository operation. In Mongo, enforce a unique `(productionId, proposalId)` index and create the approval, transition the proposal, and append the audit event in one transaction with an expected proposal status. In memory/file adapters, serialize the same operation and reject the losing decision deterministically. Return the winning existing decision on duplicate-key races.

#### 3. The default file store can lose successful commits when more than one `FileStore` instance targets the same file

- **File:** `packages/adapters/file-store/src/index.ts`
- **Lines:** 80-88, 302-328
- **Problem:** `#writeQueue` serializes writes only within one JavaScript object. Two `FileStore` instances in the same process, or two processes using the same `PCA_DATA_FILE`, independently read version N and both rename a version N+1 document into place. Both report `COMMITTED`, and the later rename silently drops the earlier mutation.
- **Why it matters:** The adapter is the default runtime store. A second server process, CLI invocation, test handle, or accidentally duplicated store instance can violate optimistic concurrency and lose approved production data. This was reproduced with two instances: both version-1 commits returned version 2.
- **Recommended fix:** Enforce exclusive ownership with an OS-level lock/lockfile held across read-check-write, or move the versioned write to storage that provides compare-and-swap. At minimum, fail startup when another process owns the data file. Extend the repository contract to run the concurrent-commit test against two reopened handles, not only one instance.

### High

#### 4. New unavailability is omitted when candidate days are generated

- **File:** `packages/application/src/use-cases/run-change-agent.ts`
- **Lines:** 296-344
- **Problem:** For `CAST_UNAVAILABLE` and `LOCATION_UNAVAILABLE`, candidate generation reads the old production state. It does not overlay the newly reported unavailability or exclude dates in the change's range, so it can rank a day that the subject has just been declared unavailable on.
- **Why it matters:** The agent may recommend an invalid target and produce an `INVALID` proposal even though other valid days exist. A reproduced Friday-through-Tuesday unavailability returned Monday and Tuesday as candidates, selected Tuesday, then failed simulation because Sarah was unavailable there. The user sees a failed plan instead of a valid alternative or `NO_CANDIDATE`.
- **Recommended fix:** Generate candidates against a snapshot with the fact operation applied, or pass the new range as `excludeDates` for the subject while still considering all other stored constraints. Select only candidates that pass a final deterministic simulation, and try the next ranked candidate if one unexpectedly fails.

#### 5. Analysis jobs cannot resume safely after an exception at `simulating` or `validating`

- **Files:** `packages/application/src/jobs/handlers.ts`; `packages/application/src/use-cases/run-change-agent.ts`
- **Lines:** `handlers.ts` 89-110; `run-change-agent.ts` 257, 392, 416
- **Problem:** A queue exception causes redelivery with the run left at its last recorded stage. The handler re-runs the whole orchestration from the beginning, whose first progress callback is `analyzing`. If the run is already `simulating` or `validating`, the tracker attempts a backward transition and throws `JobStageError` on every retry.
- **Why it matters:** A transient store/model fault after analysis becomes an unrecoverable job and exhausts retries despite the queue promising transient recovery. Reproduction from a run at `simulating` failed with “cannot move from simulating to analyzing.” Re-running the orchestration can also duplicate change requests and audit events before hitting the stage error.
- **Recommended fix:** Persist resumable step outputs and resume from the current stage, or treat one job attempt as an atomic orchestration whose tracker stage is reset through an explicit retry transition. Progress updates should be monotonic and idempotent: ignore callbacks for stages already completed. Give change-request/proposal creation stable idempotency keys so a repeated attempt cannot duplicate records.

#### 6. Job tracker updates use unprotected read-modify-write and can overwrite each other

- **File:** `packages/application/src/jobs/job-tracker.ts`
- **Lines:** 78-110
- **Problem:** `advance`, `fail`, and `note` each load a snapshot, compute a replacement, then save it without a revision check or per-job serialization. Queue transition listeners and handlers can update the same run concurrently.
- **Why it matters:** One update can erase a stage transition, retry note, message, or history entry recorded by another. A concurrent `advance` and `note` reproduction ended with the run back at `received`, losing the valid transition to `analyzing`; published WebSocket events can then disagree with canonical state.
- **Recommended fix:** Put an optimistic revision on `JobRunRepository.save` or expose an atomic `update(jobId, reducer)` operation. Serialize updates per job in the memory implementation, retry compare-and-set conflicts in durable implementations, and publish events only after the winning update commits. Add concurrent advance/note/fail tests.

#### 7. File-store saves can write invalid data and corrupt all later reads

- **File:** `packages/adapters/file-store/src/index.ts`
- **Lines:** 153-161, 173-178, 197-202, 269-299, 302-328
- **Problem:** The on-disk schema is validated only when reading. Mutation paths write the transformed object without validating `fileDatabaseSchema`. Application-only fields such as HTTP correlation/actor headers are not consistently schema-validated before persistence.
- **Why it matters:** One oversized or malformed record can be successfully written and then make every subsequent repository call fail with `STORE_CORRUPT`. This was reproduced with a 129-character correlation ID: the change request was written, its following audit append failed, and all later reads rejected the database.
- **Recommended fix:** Validate the complete transformed database with `fileDatabaseSchema.parse` before writing the temporary file. Also validate external correlation/actor headers at the HTTP boundary and validate each repository record on save across all adapters. A rejected record must leave the previous file intact.

#### 8. Repository record identity is not consistently scoped by production

- **Files:** `packages/adapters/file-store/src/index.ts`; `packages/adapters/memory-store/src/index.ts`; `packages/adapters/mongo-store/src/index.ts`
- **Lines:** `file-store/src/index.ts` 72-77, 153-218; `memory-store/src/index.ts` 208; `mongo-store/src/index.ts` 93-99
- **Problem:** File-store `replaceById` treats a globally repeated entity ID as the same record even when `productionId` differs. Memory and Mongo create composite keys by concatenating unescaped values with `::`, while entity IDs are allowed to contain colons. Distinct `(productionId, id)` pairs can therefore map to the same key.
- **Why it matters:** Saving one tenant's proposal/change/approval can overwrite or hide another tenant's record. Reproductions showed file-store records with the same ID in productions A and B replacing each other, and memory keys `(A, B::P)` and `(A::B, P)` colliding.
- **Recommended fix:** Compare both `productionId` and `id` in file-store arrays. Use an unambiguous structured key: nested maps in memory, escaped/length-prefixed encoding, or a hashed/JSON tuple. In Mongo, prefer `_id: { productionId, id }` or retain separate fields with a unique compound index. Add collision cases containing `:` to the shared repository contract.

#### 9. The rule interpreter converts affirmative availability into unavailability and truncates date ranges

- **File:** `packages/adapters/rule-model/src/index.ts`
- **Lines:** 74-85, 171-179
- **Problem:** The `UNAVAILABLE` expression explicitly matches `is available` and `are available`, so “Sarah is available Friday” resolves to `CAST_UNAVAILABLE`. `resolveDate` captures only the first ISO date (or first month/day), so “cannot shoot 2026-09-18 to 2026-09-22” becomes a one-day range.
- **Why it matters:** The default interpreter can create the opposite production fact from what the user said, or silently understate a multi-day constraint. Both cases were reproduced. Because the UI proceeds directly to proposal generation, this can lead to a human approving materially incorrect operations.
- **Recommended fix:** Separate positive and negative intent patterns and return `UNSUPPORTED` for positive availability until an “available” change type exists. Parse explicit range connectors (`to`, `through`, `until`, en dash) before single dates, validate both endpoints, and add positive/negated and multi-day contract tests.

#### 10. The domain accepts preparation tasks pointing to nonexistent entities

- **Files:** `packages/domain/src/simulation.ts`; `packages/domain/src/invariants/state.ts`
- **Lines:** `simulation.ts` 216-228; `invariants/state.ts` 107-217
- **Problem:** `CREATE_PREPARATION_TASK` inserts a task without verifying `relatedEntityType`/`relatedEntityId`. `checkSceneIntegrity` validates scene, shoot-day, call-sheet, and requirement links but never validates task links.
- **Why it matters:** An MCP caller can create an approved proposal that leaves an orphan task while simulation and global invariant verification both report valid. This breaks dependency traversal and produces a task that cannot be resolved in the UI/API. A task linked to `SCENE NONEXISTENT` was reproduced as a valid simulation.
- **Recommended fix:** Resolve the referenced entity according to `relatedEntityType` before creating the task and emit `UNKNOWN_ENTITY_REFERENCE` if absent. Add task-reference checks to INV-3 so corrupted stored state is detected independently of the operation path.

### Medium

#### 11. Realtime proposal notifications leave closed proposals in `openProposals` and do not refresh the production version

- **File:** `packages/realtime-client/src/index.ts`
- **Lines:** 216-248
- **Problem:** A known proposal notification is merged in place regardless of status. `APPLIED`, `REJECTED`, and `FAILED` records remain in an array whose contract is explicitly “open proposals.” The notification also cannot advance `productionVersion`, and the client does not recover after a known proposal is applied.
- **Why it matters:** After apply, the header can keep showing the old version and recovery-derived UI can retain a closed proposal until reconnect/manual recovery. A reproduction processed an `APPLIED` notification while leaving version 1 and an `APPLIED` item in `openProposals`.
- **Recommended fix:** On terminal proposal statuses, remove the proposal and trigger a canonical recovery; alternatively include the committed production version in the notification and update it atomically. Keep the existing recover-on-unknown behavior for new records.

#### 12. Recovery failure discards held notifications without forcing another recovery

- **File:** `packages/realtime-client/src/index.ts`
- **Lines:** 181-197, 208-213
- **Problem:** If the REST snapshot fails while socket notifications are held, the catch path clears `entry.held` and returns. It does not preserve/set `dirty`, schedule a retry, or close the socket. With no later event, the client remains stale indefinitely.
- **Why it matters:** A short REST outage at connection time can permanently hide job/proposal changes despite the WebSocket being healthy. The UI exposes only an error string and relies on a future reconnect/notification that may never occur.
- **Recommended fix:** Preserve `dirty` when held messages existed and retry recovery with bounded backoff while the socket remains subscribed. Do not apply held messages without a baseline; retain them until a successful snapshot or deliberately reconnect to re-establish the ordering boundary.

#### 13. Manual schedule-change proposals do not automatically stale affected published call sheets

- **File:** `packages/application/src/use-cases/run-change-agent.ts`
- **Lines:** 378-386
- **Problem:** The orchestrated `SCHEDULE_CHANGED` path adds stale marks, but public MCP callers can submit a raw `MOVE_SCENES` operation without corresponding `MARK_CALL_SHEET_STALE` operations. Simulation/invariants do not consider a still-published sheet inconsistent with its changed shoot day.
- **Why it matters:** The central write tool can move scenes while leaving both source and target call sheets `PUBLISHED`, so crew-facing documents no longer reflect production state. A direct simulation of moving S18 was valid while all call sheets remained published.
- **Recommended fix:** Derive call-sheet invalidation inside domain application from every `MOVE_SCENES`, rather than requiring callers to remember a second operation. If explicit operations are required for approval transparency, validation should reject a move that omits required stale marks and explain which IDs are missing.

#### 14. Verification output can violate its own MCP contract for valid proposal input

- **Files:** `packages/domain/src/verification.ts`; `packages/contracts/src/mcp.ts`
- **Lines:** `verification.ts` 129-145; `contracts/src/mcp.ts` 271-281
- **Problem:** Verification check names embed user-controlled operation titles/names, but the output schema caps each name at 120 characters. Valid task titles allow 300 characters. The use case succeeds with a long check name, after which MCP output validation converts it to `INTERNAL_ERROR`.
- **Why it matters:** A valid, applied proposal can become unverifiable through the public tool solely because of display text length. A 150-character task title produced a 172-character check name rejected by the output schema.
- **Recommended fix:** Make check `name` a short stable label or code and put variable detail in the 2,000-character `detail` field. Align all producer limits with output contracts and add max-length boundary tests.

#### 15. Schedule and audit pages have unhandled request failures and stale-response races

- **Files:** `apps/web/src/app/pages/schedule-page.ts`; `apps/web/src/app/pages/audit-page.ts`
- **Lines:** `schedule-page.ts` 109-125; `audit-page.ts` 92-97
- **Problem:** Both effects launch promises without catch handling. If navigation changes production while a request is in flight, the old response can overwrite the new page. Any failed schedule/scene/audit request becomes an unhandled rejection and leaves an indefinite loading state.
- **Why it matters:** Slow networks or rapid navigation can display another production's data under the current production header, and transient errors give no recoverable UI. `Promise.all` makes one missing scene fail the whole schedule.
- **Recommended fix:** Track a request generation/production ID and ignore stale completions, catch and expose a typed error state, and use cancellation (`switchMap`/abort signal) where practical. For scene enrichment, consider a normalized schedule endpoint or handle individual scene failures explicitly.

#### 16. Schedule rendering performs an N+1 set of full-production reads

- **Files:** `apps/web/src/app/pages/schedule-page.ts`; `apps/mcp-server/src/handlers/read-tools.ts`
- **Lines:** `schedule-page.ts` 117-125; `read-tools.ts` 47-57, 108-136, 211-230
- **Problem:** The page fetches the schedule, then requests every distinct scene. Each `get_scene` request independently loads and indexes the complete production snapshot. File store therefore reads/parses the entire JSON document N+1 times; Mongo performs eight collection queries per scene request.
- **Why it matters:** Latency and database work grow with scene count, precisely on a page expected to show the full schedule. Parallel requests reduce wall-clock time but increase burst load and memory/JSON parsing.
- **Recommended fix:** Add a read model/endpoint that returns scheduled days with normalized scene/location/cast data in one snapshot load, or add a batch `get_scenes` operation. Reuse one `ProductionIndex` within a request and measure query count in an integration test.

#### 17. Production build does not type-check imported workspace source files through Angular's compiler

- **Files:** `apps/web/tsconfig.app.json`; `apps/web/tsconfig.json`
- **Lines:** `tsconfig.app.json` 3-5; `tsconfig.json` 1-26
- **Problem:** The Angular production build warns that `@pca/realtime-client` and multiple `@pca/contracts` source files are bundled but not part of the TypeScript program. The root typecheck explicitly excludes `apps/web`, so the intended type-safety boundary is split and Angular reports an actual coverage gap.
- **Why it matters:** Cross-package source used by the browser can be bundled without the same Angular build-time checking as application sources. Warnings are easy to normalize, and a future contract/client change may compile in one pipeline while failing at runtime or under a different bundler.
- **Recommended fix:** Include the imported workspace source packages in the app TypeScript program, or build them as proper libraries with declarations and consume their built entry points. Treat Angular “not found in TypeScript compilation” warnings as CI failures.

### Low

#### 18. Memory-store commits retain caller-owned object references

- **File:** `packages/adapters/memory-store/src/index.ts`
- **Lines:** 188-202
- **Problem:** `save` clones inputs, but `commit` inserts incoming entity objects directly through `upsertById`. Mutating an input object after `commit` mutates stored state without a repository call or version increment.
- **Why it matters:** This violates the adapter's stated copy-on-write behavior and makes tests/local runtime behavior differ from Mongo/file stores. It can create hard-to-reproduce state changes in callers that reuse mutable objects.
- **Recommended fix:** Clone mutation records before storing (or clone the complete next state), and add a repository contract test that mutates the original commit input after the call.

#### 19. Queue idempotency keys are global instead of scoped to production/job type

- **File:** `packages/adapters/memory-queue/src/index.ts`
- **Lines:** 82, 220-233
- **Problem:** `jobIdByKey` indexes only the raw idempotency key. The same key used by different productions or job types is treated as a duplicate of the first job.
- **Why it matters:** One tenant can suppress another tenant's legitimate job when client-generated keys collide. A reproduction enqueued the same key for productions A and B and received `ENQUEUED`, then `DUPLICATE`.
- **Recommended fix:** Scope queue identity by at least `(productionId, type, idempotencyKey)`, document the tuple in the port contract, and test cross-production reuse as is already done for write idempotency records.

#### 20. Model validation is redundantly wrapped up to three times

- **Files:** `packages/bootstrap/src/index.ts`; `packages/application/src/use-cases/run-change-agent.ts`; `packages/application/src/use-cases/interpret-change.ts`
- **Lines:** `bootstrap/src/index.ts` 178-190; `run-change-agent.ts` 166-180; `interpret-change.ts` 83-96
- **Problem:** Bootstrap returns a guarded model, `runChangeAgent` guards it again, and `createInterpretChange` guards that guarded model once more. The code comments acknowledge only two layers. Each layer parses output, runs grounding checks, and installs timeout machinery.
- **Why it matters:** It adds complexity and repeated validation to every model call, complicates latency logging/timeout semantics, and makes it unclear which layer owns the trust boundary.
- **Recommended fix:** Choose one boundary—preferably the application composition point—and accept a clearly named untrusted `ModelPort` there. Remove inner/outer duplicate guards and test that all production composition roots pass through the single guard.

#### 21. Several exported domain helpers have no production consumer

- **Files:** `packages/domain/src/operations.ts`; `packages/domain/src/invariants/guards.ts`
- **Lines:** `operations.ts` 72-98; `invariants/guards.ts` 202-220, 276-277
- **Problem:** `pendingOperations`, `staleCallSheetIdsForShootDays`, `checkVersionIncremented`, and `idempotencyKeyForProposal` are exported and tested but unused by runtime code. In particular, callers hand-build idempotency keys and stale-mark logic elsewhere.
- **Why it matters:** Duplicate concepts drift: stale call-sheet logic already differs between orchestrated and raw proposal paths, and the UI uses a random key instead of the domain helper. Tests of unused helpers create confidence without protecting runtime behavior.
- **Recommended fix:** Wire the helpers into the actual use cases and UI/API key derivation where they represent intended policy, or remove them and their isolated tests. Keep one implementation for each rule.

## Validation performed

- `pnpm typecheck` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- `pnpm test` — 47 files, 697 tests passed
- `pnpm test:integration` — 5 files, 132 tests passed (file and Mongo adapters)
- `pnpm test:contract` — 8 files, 169 tests passed
- `pnpm test:web` — 19 files, 107 tests passed
- `pnpm test:e2e` — 3 Playwright scenarios passed
- `pnpm build` — passed outside the restricted sandbox; Angular emitted a 169.42 kB initial bundle budget warning and workspace-source type-compilation warnings

The automated suites cover the three documented golden scenarios well, but most findings above occur at concurrency, partial-failure, maximum-length, multi-tenant-key, multi-instance, or broader natural-language boundaries that the current suites do not exercise.
