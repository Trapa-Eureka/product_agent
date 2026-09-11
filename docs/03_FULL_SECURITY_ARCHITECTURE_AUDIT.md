# Full Security and Architecture Audit

- Audit date: 2026-09-11 (Asia/Manila)
- Audited revision: `c6ddb4ee9b4cbc55e826fd2703dbe003a2a3b626`
- Scope: all tracked application, domain, adapter, UI, test, build, CI/CD, configuration, and architecture/documentation files, plus the resolved dependency graph
- Perspective: application security, architecture integrity, identity and access, data isolation, persistence, availability, AI/LLM trust, secrets, observability, supply chain, infrastructure, and production readiness

## Prioritized findings

### Critical

#### AUD-001 — Unauthenticated callers can impersonate a human approver and execute consequential writes

- **Affected files:** `apps/api/src/app.ts`; `apps/api/src/main.ts`; `packages/application/src/use-cases/decide-proposal.ts`
- **Evidence:** `apps/api/src/app.ts` 53-56 and 85-91 accept a caller-controlled `X-Actor-Id` as the user identity. Lines 199-210 check only a process-wide production allow-list. Lines 377-457 expose decision and apply routes without authentication. `decide-proposal.ts` 141-177 persists that unverified value as `approvedBy` and as the audit actor. `main.ts` 85-87 permits binding the service to a non-loopback interface.
- **Attack or failure scenario:** A client that can reach the API names a known production and proposal, sends `APPROVE` with another person's identity in `X-Actor-Id`, receives the approval ID, and invokes `/apply`. The digest/version checks all pass because the attacker has created a syntactically valid approval. The resulting mutation and audit trail falsely attribute the decision to the victim.
- **Why it matters:** Authentication, authorization, human approval, non-repudiation, and audit integrity fail together. The project enforces the shape of an approval but not the authority of its issuer, so the central safety boundary is not meaningful outside a single trusted local operator.
- **Recommended remediation:** Require authentication for every non-health HTTP route and WebSocket upgrade. Validate an OIDC/JWT or server-side session and derive identity solely from verified claims. Enforce per-production RBAC/ABAC, a dedicated approver permission, and maker-checker separation. Remove direct trust in `X-Actor-Id`, or accept it only from an authenticated trusted proxy that strips client copies. Persist immutable subject, issuer, role, and authentication assurance with each decision.

#### AUD-002 — A production mutation is not atomic with its idempotency, proposal-status, and audit records

- **Affected file:** `packages/application/src/use-cases/apply-approved-proposal.ts`
- **Evidence:** Lines 249-255 commit business state first. Lines 269-280 then independently save the idempotency record, mark the proposal `APPLIED`, and append audit evidence. The file comment at lines 39-41 explicitly acknowledges that the steps are not one transaction for memory/file storage.
- **Attack or failure scenario:** The production commit succeeds and the process crashes, disk fills, or a repository call fails before line 278. Production data has changed, but the proposal remains `APPROVED`, the apply audit is absent, and the replay record does not exist. A retry observes the incremented version and fails rather than recovering the successful result.
- **Why it matters:** The most sensitive write can become unaudited and unrecoverable, while the API/queue reports failure. This breaks exactly-once behavior, approval workflow truth, incident reconstruction, and the documented `APPROVE → WRITE → VERIFY` control sequence.
- **Recommended remediation:** Add a repository unit-of-work that atomically performs the version compare-and-set, entity mutation, idempotency insert, proposal transition, and audit append. Use one Mongo transaction and one validated file-store read-modify-write. If future services split these stores, use a durable operation/outbox state machine that can prove and reconcile partial completion before accepting retries.

### High

#### AUD-003 — Missing authorization configuration grants wildcard access instead of failing closed

- **Affected files:** `apps/mcp-server/src/context.ts`; `apps/api/src/server.ts`; `README.md`
- **Evidence:** `context.ts` 21-33 maps an unset, blank, or `*` `PCA_ALLOWED_PRODUCTIONS` to wildcard access. Lines 36-38 then authorize every production. `apps/api/src/server.ts` 31-37 reuses this setting for WebSockets. `README.md` 157-170 documents `*` as the default.
- **Attack or failure scenario:** An operator forgets one environment variable in a container or service definition. REST, MCP, and realtime access silently start with maximum production scope. Combined with AUD-001, any reachable caller can read and mutate every production whose ID it can discover.
- **Recommended remediation:** Default to no productions and fail startup on absent/empty configuration. Permit `*` only behind an explicit local-demo flag that cannot be enabled in the production build/profile. Parse configured IDs with `entityIdSchema`. Ultimately derive production grants from the authenticated principal rather than one process-global environment value.

#### AUD-004 — Concurrent approve and reject requests can both succeed and leave contradictory authority records

- **Affected files:** `packages/application/src/use-cases/decide-proposal.ts`; `packages/adapters/mongo-store/src/index.ts`; `packages/adapters/file-store/src/index.ts`; `packages/adapters/memory-store/src/index.ts`
- **Evidence:** `decide-proposal.ts` 72-87 performs an existence read, then lines 141-177 create the decision, proposal status, and audit in separate calls. Mongo creates a non-unique approval index at lines 155-167 and keys approvals by generated approval ID at lines 380-401. File and memory stores at `file-store/src/index.ts` 197-219 and `memory-store/src/index.ts` 117-129 likewise allow several approval IDs for one proposal.
- **Attack or failure scenario:** Two requests race after both see “no existing decision.” One writes APPROVE and the other REJECT. Both return success; both decision records can exist, proposal status is last-writer-wins, and `findByProposalId` can select a record inconsistent with the displayed status. An approval record may remain usable despite a human's rejection.
- **Recommended remediation:** Implement an atomic `recordProposalDecision` operation with expected status. In Mongo, use a unique `(productionId, proposalId)` index and one transaction; in file/memory adapters, serialize one compare-and-set mutation. Append audit evidence in the same operation and make the losing caller receive the already-recorded decision.

#### AUD-005 — Tenant keys are ambiguous or incompletely scoped, allowing cross-production record collisions

- **Affected files:** `packages/contracts/src/primitives.ts`; `packages/adapters/file-store/src/index.ts`; `packages/adapters/memory-store/src/index.ts`; `packages/adapters/mongo-store/src/index.ts`
- **Evidence:** `primitives.ts` 15-21 allows colons in entity IDs. File-store `replaceById` at lines 72-77 compares only `id`, although workflow arrays contain records from every production. Memory-store line 208 and Mongo line 93 encode scope as the unescaped string `${productionId}::${id}`.
- **Attack or failure scenario:** In the file store, productions A and B save a proposal/change/approval with the same ID and one replaces the other. In memory/Mongo, tuples `(A, B::P)` and `(A::B, P)` produce the same key. A read in one tenant can then hide, overwrite, or return state derived from another tenant's record.
- **Why it matters:** Production isolation is a stated invariant and an authorization boundary. ID generation makes accidental collisions less frequent in normal runtime, but imports, fixtures, migrations, deterministic IDs, and colon-containing IDs make the defect reachable.
- **Recommended remediation:** Use tuple-safe keys: nested maps in memory, compare both `productionId` and `id` in file arrays, and use a structured Mongo `_id` or a unique compound index. Alternatively prohibit the delimiter everywhere, including existing data migrations. Add shared repository-contract tests with duplicate IDs across productions and delimiter-containing IDs.

#### AUD-006 — The default file database has no inter-process concurrency control and can silently lose approved writes

- **Affected files:** `packages/adapters/file-store/src/index.ts`; `README.md`
- **Evidence:** `file-store/src/index.ts` 80-88 holds a write queue only inside one `FileStore` object. Lines 302-328 perform read-modify-write and atomic rename but no OS lock or cross-process compare-and-swap. `README.md` 210-214 and 228-233 acknowledge single-operator/single-process constraints while the adapter remains the default.
- **Attack or failure scenario:** Two API processes, a seed process and API, or two store instances read version N. Each commits a different version N+1 document and reports success; the later rename discards the first approved mutation and its records.
- **Why it matters:** Atomic rename prevents torn files, not lost updates. A routine deployment mistake or concurrent administrative command can silently erase production and audit data.
- **Recommended remediation:** Hold an OS-level exclusive lock across read/check/write and reject a second owner at startup, or use a database with compare-and-swap for any multi-process deployment. Make the seed/reset command acquire the same lock. Add two-handle/two-process concurrency tests rather than testing only one object instance.

#### AUD-007 — WebSocket upgrades have neither client authentication nor Origin validation

- **Affected files:** `apps/api/src/server.ts`; `packages/adapters/ws-gateway/src/index.ts`
- **Evidence:** `apps/api/src/server.ts` 31-39 supplies only the global production allow-list. `ws-gateway/src/index.ts` 170-181 accepts connections without identity, and lines 217-228 accept any upgrade on the configured path without validating `Origin`, `Host`, a token, or session.
- **Attack or failure scenario:** A malicious website opens `ws://127.0.0.1:3000/ws` from a developer's browser and subscribes to the known demo production, or a remote client connects to an externally bound instance. It receives proposal and job notifications. Adding cookie authentication later would turn the same gap into cross-site WebSocket hijacking.
- **Recommended remediation:** Authenticate before `handleUpgrade`, authorize subscriptions per principal, enforce an exact browser Origin allow-list and trusted Host/proxy policy, and reject invalid upgrades with 401/403. Use short-lived audience-bound tokens or secure sessions and add negative tests for missing/foreign Origin and invalid credentials.

#### AUD-008 — Unauthenticated HTTP/WebSocket clients can exhaust memory, CPU, queue capacity, and persistent audit storage

- **Affected files:** `apps/api/src/app.ts`; `packages/adapters/ws-gateway/src/index.ts`; `packages/contracts/src/change.ts`; `packages/contracts/src/mcp.ts`; `packages/contracts/src/proposal.ts`
- **Evidence:** The API installs only a 256 KiB JSON body limit at `app.ts` 171-174; no request, actor, IP, job, or expensive-route rate limit exists. `ws-gateway/src/index.ts` 100-107 constructs `WebSocketServer` without `maxPayload`, leaving the installed `ws` default at 100 MiB, then lines 75-97 buffer, decode, parse, and validate the whole message. Client connections and message frequency are unbounded. Externally supplied arrays at `change.ts` 48-52, `mcp.ts` 176-180/223-227/256-262, and `proposal.ts` 23-28/97-105 have no maximum cardinality.
- **Attack or failure scenario:** A client opens many sockets, sends large frames, floods `/changes`, or submits thousands of scene IDs/operations in repeated requests. The server performs JSON parsing, deterministic simulation/model orchestration, queue insertion, and audit growth until memory or CPU is exhausted.
- **Recommended remediation:** Set a small explicit WebSocket `maxPayload`, connection caps, idle/handshake timeouts, and per-principal/IP message limits. Add global and route-specific HTTP rate limiting, authenticated quotas, queue/backpressure limits, bounded job/audit retention, and maximum schema cardinalities based on real production limits. Return 429 and instrument rejected work.

#### AUD-009 — Queue and JobRun state are process-local even when Mongo is selected, so restart loses workflow truth

- **Affected files:** `apps/api/src/main.ts`; `packages/bootstrap/src/index.ts`; `packages/adapters/memory-queue/src/index.ts`
- **Evidence:** `main.ts` 50-53 always selects the only available memory queue and creates its associated in-memory JobRun repository. `bootstrap/src/index.ts` 197-234 throws for SQS and returns a memory JobRun repository for the only usable queue. `memory-queue/src/index.ts` 75-92, 210-292, and 299-318 stores jobs, ready work, retries, dead letters, and runs in Maps/arrays.
- **Attack or failure scenario:** The API restarts after accepting an analysis/apply request or during retry. Mongo/file business records survive, but queued work, retry/dead-letter state, and all JobRuns vanish. Clients cannot recover the job timeline; an approved apply may never run, or operators may resubmit without knowing what completed.
- **Recommended remediation:** Do not present the current composition as production-capable asynchronous processing. Add a durable queue and durable JobRun repository with at-least-once delivery, visibility timeout, DLQ, deduplication, and recovery reconciliation. On startup, scan durable nonterminal operations and resume safely. Define recovery point/time objectives and chaos-test restarts at every stage.

#### AUD-010 — Unvalidated identity/tracing inputs can persist an invalid default database and cause restart-persistent denial of service

- **Affected files:** `apps/api/src/app.ts`; `apps/mcp-server/src/context.ts`; `packages/contracts/src/primitives.ts`; `packages/contracts/src/change.ts`; `packages/application/src/use-cases/submit-change-request.ts`; `packages/adapters/file-store/src/index.ts`
- **Evidence:** `app.ts` 85-91 trims but does not validate `X-Correlation-Id` or `X-Actor-Id`; `context.ts` 21-33 does the same for `PCA_ACTOR_ID`. Contracts cap correlation IDs at 128 characters (`primitives.ts` 59-63) and actors at 200 (`change.ts` 70-80). `submit-change-request.ts` 119-146 constructs and saves these values without parsing the complete record. File-store lines 269-299 validate only on read and lines 302-328 write the transformed database without validating it.
- **Attack or failure scenario:** A single request supplies a 129-character correlation ID or oversized actor, causing an invalid change request to be written. A following repository read rejects the entire JSON database as corrupt, and restart continues to fail until the file is manually repaired or reset.
- **Recommended remediation:** Strictly parse all headers and environment-derived identities before creating context; generate a new correlation ID when input is invalid. Validate records on every repository save and validate the complete next `FileDatabase` before rename. Invalid input must leave the prior database untouched. Derive actor identity from AUD-001's authentication layer.

### Medium

#### AUD-011 — Raw infrastructure error messages are copied into user-readable JobRuns and operator logs

- **Affected files:** `packages/application/src/infrastructure-error.ts`; `packages/adapters/memory-queue/src/index.ts`; `packages/application/src/jobs/handlers.ts`; `apps/api/src/app.ts`; `apps/api/src/invoke.ts`
- **Evidence:** `infrastructure-error.ts` 20-56 builds public descriptions from the original exception message. `memory-queue/src/index.ts` 175-181 puts that description into the retry reason. `jobs/handlers.ts` 285-302 copies retry/final reasons into JobRun history. `app.ts` 543-566 exposes jobs/recovery, while lines 600-617 log raw exception messages. `invoke.ts` 53-71 logs `describeFailure`. The failure-injection test at `packages/application/test/failure-injection.test.ts` 152-200 explicitly asserts that the raw `socket hang up` cause reaches JobRun history.
- **Attack or failure scenario:** A Mongo/network/file error containing internal hosts, database names, paths, query details, or credentials is persisted as a retry note. Any caller able to read jobs/recovery—including unauthenticated callers today—receives it. The same cause enters central logs without redaction.
- **Recommended remediation:** Separate internal diagnostics from public status. Store a stable boundary code and correlation ID in JobRuns; send the full exception only to a protected logger after structured redaction. Sanitize connection strings, filesystem paths, headers, and provider responses. Add tests using credential-bearing fake causes and assert they never appear in HTTP/MCP/job/audit output.

#### AUD-012 — Proposal/job relationships and requester ownership are not enforced

- **Affected files:** `apps/api/src/app.ts`; `packages/application/src/jobs/handlers.ts`
- **Evidence:** `app.ts` 394-409 completes a supplied job after rejection if it merely belongs to the same production. Lines 437-456 enqueue an apply under any same-production job. Lines 470-500 resume any same-production job. `jobs/handlers.ts` 175-220 validates stage but never requires `run.proposalId === payload.proposalId`, matching job type, or requester ownership.
- **Attack or failure scenario:** A user attaches proposal P2 to P1's awaiting-approval job, completes another user's job as rejected, or resumes a resolving job with unrelated text/change. Business apply guards may still protect the production operation itself, but canonical workflow and realtime evidence are corrupted.
- **Recommended remediation:** Persist and check immutable associations among principal, production, job type, change request, proposal, and approval. Enforce them both before enqueue and inside the handler. Use atomic expected-stage transitions and reject mismatches without changing the job.

#### AUD-013 — Job state updates and retry behavior are not concurrency-safe or restart-safe

- **Affected files:** `packages/application/src/jobs/job-tracker.ts`; `packages/application/src/jobs/handlers.ts`; `packages/application/src/use-cases/run-change-agent.ts`
- **Evidence:** `job-tracker.ts` 78-110 loads, transforms, and replaces a JobRun without a revision or per-job lock, then publishes events. Queue listeners and handlers can update the same job concurrently. `handlers.ts` 89-110 reruns orchestration from the beginning after delivery retry, while `run-change-agent.ts` 257, 392, and 416 emits forward-stage callbacks that can become illegal backward transitions when the stored job is already at `simulating` or `validating`.
- **Attack or failure scenario:** A retry note races an advance and overwrites the new stage/history. A transient fault after simulation redelivers the whole job, attempts to advance back to `analyzing`, and repeatedly fails until dead-lettered. Re-execution may duplicate change requests and audit events.
- **Recommended remediation:** Add a monotonic JobRun revision and atomic compare-and-set/update operation, serialize updates per job, and publish only committed events. Persist step outputs and resume from the recorded stage, or make the entire attempt explicitly restartable with idempotent creation keys. Test concurrent `advance`/`note`/`fail` and faults at every orchestration stage.

#### AUD-014 — Free-form model prose is not grounded and can socially engineer the approval decision

- **Affected files:** `packages/application/src/ports/model.ts`; `packages/application/src/use-cases/run-change-agent.ts`; `packages/contracts/src/explanation.ts`
- **Evidence:** `model.ts` 72-121 grounds interpretation IDs and candidate permutations, but lines 219-227 only schema-parse `explainImpact`. `run-change-agent.ts` 283-289 sends raw user text and deterministic findings to the model; lines 400-414 insert its answer as proposal narrative. `explanation.ts` 27-34 permits the narrative as arbitrary nonempty text up to the shared explanation limit.
- **Attack or failure scenario:** Prompt-injected user input or a compromised future provider returns “No conflict; authorized by production management” or otherwise misleading claims. It cannot add an operation, but its text appears beside deterministic facts at the exact point a human decides whether to approve.
- **Recommended remediation:** Keep every approval-critical statement deterministic. Visually label/separate model narrative as untrusted, prohibit authorization/safety claims, and foreground exact operations, conflicts, version, and digest. Prefer a closed fact-reference output whose references are validated against supplied findings. Add adversarial tests for misleading but schema-valid output, indirect prompt injection, data exfiltration requests, and instruction hierarchy attacks.

#### AUD-015 — There is no reproducible production artifact or deployment security baseline despite documentation implying one

- **Affected files:** `package.json`; `apps/api/package.json`; `apps/web/package.json`; `README.md`; `ARCHITECTURE.md`; `docs/WORK_PLAN.md`
- **Evidence:** Root `package.json` 1-26 is private, declares no `bin`, no serve command, and its recursive build runs only packages that define a build script. `apps/api/package.json` 1-20 is private and exports TypeScript source without a build/start script. Only the Angular app has a production build (`apps/web/package.json` 6-9), and Express does not serve those assets. No Dockerfile, deployment manifest, Terraform file, reverse-proxy/TLS configuration, IAM policy, or secret-manager configuration exists. This conflicts with `README.md` 84-103 and 198-204 and `docs/WORK_PLAN.md` 122-143, which describe Terraform, a public `npx` package, a CLI, and prebuilt UI serving; the same work plan at 107-112 says infrastructure/deployment is deferred.
- **Attack or failure scenario:** An operator follows the documented architecture and deploys `tsx` plus Angular's development server, omits TLS/auth/reverse-proxy controls, or creates ad hoc cloud permissions and networking. Security behavior becomes environment-specific and cannot be reviewed, reproduced, or promoted safely.
- **Recommended remediation:** Mark the repository explicitly demo-only until a production target exists. Create a versioned, minimal runtime artifact; serve the built UI through a defined origin; provide hardened container/runtime and IaC; specify TLS termination, proxy trust, network policies, IAM, secret injection, non-root filesystem, resource limits, health/readiness, rollback, backup, and deployment promotion. Make README claims match executable artifacts and CI verification.

#### AUD-016 — Mongo production connections do not enforce encrypted/authenticated deployment settings or operational recovery controls

- **Affected files:** `packages/adapters/mongo-store/src/index.ts`; `packages/bootstrap/src/index.ts`; `README.md`
- **Evidence:** `mongo-store/src/index.ts` 63-70 accepts an arbitrary URI, and lines 117-135 pass it directly to `MongoClient`; the only startup security/availability check is replica-set presence. `bootstrap/src/index.ts` 43-61 accepts URI/database name from environment without a production policy. `README.md` 157-170 documents configuration but not TLS, authentication, certificate verification, network restriction, backup, restore, migration, retention, or credential rotation.
- **Attack or failure scenario:** A deployment uses a remote `mongodb://` URI without TLS or overly privileged credentials. Traffic/credentials may be exposed on the network, or an application compromise can alter every collection. Separately, corruption/operator error has no documented backup/restore or schema migration path.
- **Recommended remediation:** In production mode require `mongodb+srv` or `tls=true` with certificate verification, authenticated least-privilege credentials from a secret manager, restricted network access, bounded pool/timeouts, and an explicit database allow-list. Add tested backup/PITR and restore procedures, schema/index migration ownership, credential rotation, and database-level validation where feasible.

#### AUD-017 — Sensitive production data is stored and duplicated without restrictive file permissions, retention, or field-level access

- **Affected files:** `packages/adapters/file-store/src/index.ts`; `packages/application/src/use-cases/submit-change-request.ts`; `apps/api/src/app.ts`; `apps/web/src/app/pages/audit-format.ts`
- **Evidence:** File-store lines 49-55 and 323-329 create the database directory/file with ambient umask rather than explicit `0700`/`0600`. `submit-change-request.ts` 119-146 stores raw text both in the ChangeRequest and audit metadata. `app.ts` 524-582 returns change requests and audit records, and `audit-format.ts` 46-54 renders the raw sentence. No retention, redaction, encryption, or field-level access policy exists.
- **Attack or failure scenario:** On a typical `022` umask the local database may be readable by other host users. A user pastes credentials, contact details, or unreleased production information; it is duplicated indefinitely and made available to every production reader.
- **Recommended remediation:** Create directories/files with `0700`/`0600`, validate ownership, and use managed encryption at rest for real deployments. Classify data, warn against secrets, redact high-confidence credentials, avoid duplicating raw text in audit metadata, restrict raw-text access, and implement retention/deletion policies plus auditable backup handling.

#### AUD-018 — The locked development toolchain contains a current arbitrary-file-read advisory

- **Affected files:** `package.json`; `pnpm-lock.yaml`
- **Evidence:** Root `package.json` 28-43 allows Vitest 3.x. Lockfile lines 53-55, 2043-2050, 3777-3787, 5421-5427, and 7330-7353 resolve `vitest@3.2.7` and `@vitest/mocker@3.2.7`. On 2026-09-11, `pnpm audit --json` reported GHSA-82fw-gwwq-j7x9 / CVE-2026-84373 (moderate), an arbitrary file read reachable in affected mocker/dev-server configurations. `pnpm audit --prod` reported zero production advisories.
- **Attack or failure scenario:** If an affected developer/CI Vite integration is exposed, a client registers a redirect mock outside the workspace and reads files available to that process, potentially including `.env` data and credentials.
- **Recommended remediation:** Upgrade root Vitest to `>=4.1.11`, regenerate the lockfile, and run the full verification suite and audit. Do not expose development/test servers. Add automated advisory review for both production and development dependencies.

#### AUD-019 — CI lacks a defined least-privilege and supply-chain verification policy

- **Affected files:** `.github/workflows/ci.yml`; `scripts/verify.mjs`; `packages/adapters/mongo-store/test/replica-set.ts`; `.gitlab-ci.yml`
- **Evidence:** GitHub Actions lines 25-30 use mutable major tags and the workflow declares no explicit `permissions`. `scripts/verify.mjs` 11-21 runs quality/tests/build but no dependency audit, secret scan, SAST, SBOM, license/provenance check, or artifact signing. `replica-set.ts` 11-20 downloads and executes a Mongo binary without pinning the binary version in repository configuration. The documentation-only GitLab path uses mutable `node:22-slim` and unpinned apt packages at `.gitlab-ci.yml` 23 and 91-102.
- **Attack or failure scenario:** An upstream action/tag, registry dependency, browser download, or test binary changes or is compromised and executes with CI permissions. A vulnerable dependency such as AUD-018 still passes `verify`, and there is no SBOM/provenance record for a release artifact.
- **Recommended remediation:** Pin actions and container images by full immutable digest/SHA; set `permissions: contents: read` (and only narrowly add others); pin test binary versions/checksums; add dependency/secret/SAST scans with triage policy; generate an SBOM; and sign/attest immutable release artifacts. Keep untrusted pull-request jobs isolated from secrets and deployment credentials.

#### AUD-020 — Mongo trusts workflow, approval, idempotency, and audit documents through unchecked casts

- **Affected file:** `packages/adapters/mongo-store/src/index.ts`
- **Evidence:** Lines 100-104 strip `_id` and cast to `T`. Production snapshots are schema-validated at lines 181-227, but lines 340-442 return ChangeRequest, Proposal, Approval, AuditEvent, and IdempotencyRecord documents without their Zod schemas.
- **Attack or failure scenario:** An older writer, partial migration, operator edit, or corruption stores an invalid approval/proposal/status. Application guards and UI receive it as though TypeScript had validated it, causing fail-open assumptions, crashes, misleading state, or unreliable audit evidence.
- **Recommended remediation:** Parse each document with its strict contract schema on both read and write, including a persisted idempotency schema. Convert failures to a stable redacted `STORE_CORRUPT` error. Add Mongo collection validators/migrations where practical and test malformed stored records.

#### AUD-021 — Monitoring and health checks cannot establish readiness, saturation, security abuse, or control failures

- **Affected files:** `apps/api/src/app.ts`; `apps/api/src/logging.ts`; `packages/application/src/infrastructure-error.ts`; `apps/api/src/main.ts`
- **Evidence:** `app.ts` 195-197 always returns `ok` without checking storage, queue, or job handler readiness. Logging is JSON to stderr only (`logging.ts` 7-10). Repository/model failures are timed, but `infrastructure-error.ts` 89-94 records failed DB calls at `info`. `main.ts` 88-95 logs startup configuration but no metrics/alert wiring exists. No counters, histograms, traces, dashboards, SLOs, audit alerts, or liveness/readiness split are present.
- **Attack or failure scenario:** The process returns healthy while Mongo is unavailable, the queue is saturated/lost, or all work is failing. Approval anomalies, authorization denials, rate-limit abuse, retry storms, dead letters, and unaudited mutations do not trigger alerts. Orchestration continues routing traffic to an unhealthy instance.
- **Recommended remediation:** Add separate liveness/readiness endpoints with bounded dependency checks; expose metrics for request/auth failures, latency, queue depth/age, retries, DLQ, model errors, version conflicts, decisions, and apply/verify outcomes; emit error severity correctly; and define SLO-based alerts. Protect diagnostic endpoints and define log retention, access control, redaction, integrity, and correlation with audit records.

### Low

#### AUD-022 — The WebSocket subscription limit can be bypassed by concurrent messages

- **Affected file:** `packages/adapters/ws-gateway/src/index.ts`
- **Evidence:** Lines 126-168 check `subscriptions.size`, then await an asynchronous authorization decision before adding. Lines 180-182 launch every handler without per-client sequencing. Several subscribe handlers can all pass the size check before any adds. The test at `packages/adapters/ws-gateway/test/ws-gateway.test.ts` 243-251 checks only sequential subscriptions.
- **Attack or failure scenario:** A client sends more than 16 subscribe frames without waiting while authorization is delayed. All observe available capacity and later add, increasing received data scope and per-notification broadcast work beyond the intended limit.
- **Recommended remediation:** Serialize messages per connection or reserve/recheck capacity inside a per-client mutex after authorization. Test concurrent sends with a deliberately delayed authorizer.

#### AUD-023 — Model timeouts reject the caller but do not cancel provider work

- **Affected files:** `packages/application/src/ports/model.ts`; `packages/bootstrap/src/index.ts`
- **Evidence:** `model.ts` 130-180 uses `Promise.race` and clears only the timer; no abort signal reaches the provider. `bootstrap/src/index.ts` 178-189 shows external Ollama/Bedrock adapters are currently deferred, limiting present exploitability.
- **Attack or failure scenario:** After a provider is implemented, timed-out requests keep consuming sockets, concurrency, paid tokens, and memory while clients retry. A request flood multiplies orphan work.
- **Recommended remediation:** Add `AbortSignal` to `ModelPort`, abort on timeout/client cancellation, bound provider concurrency, and test that adapters actually stop network work.

#### AUD-024 — HTTP and browser defense-in-depth headers are left entirely to an unspecified deployment layer

- **Affected files:** `apps/api/src/app.ts`; `apps/api/src/server.ts`; `apps/web/src/index.html`
- **Evidence:** `app.ts` 171-174 disables `X-Powered-By` and installs JSON parsing but no CSP, `X-Content-Type-Options`, frame restriction, Referrer Policy, sensitive-response cache policy, or HSTS behavior. `server.ts` 27-55 serves plain HTTP. No reverse-proxy configuration in the repository supplies the missing policy. Reviewed Angular templates use interpolation and no `innerHTML`/sanitizer bypass was found.
- **Attack or failure scenario:** A future XSS regression has no CSP containment; the application can be framed for clickjacking; sensitive JSON may be cached; and an ad hoc direct deployment serves plaintext traffic.
- **Recommended remediation:** Define headers centrally in Express or the versioned trusted proxy, apply `Cache-Control: no-store` where appropriate, enforce TLS/HSTS in production, and test the final deployed response—not only the app in isolation. Use a strict Angular-compatible CSP without broad unsafe allowances.

#### AUD-025 — Identifier entropy is unnecessarily truncated for long-lived operational records

- **Affected file:** `packages/application/src/ports/clock.ts`
- **Evidence:** Lines 26-28 generate a UUID but retain only 12 hexadecimal characters (48 bits) for every change request, proposal, approval, audit event, correlation ID, queue job, and JobRun.
- **Attack or failure scenario:** At high cumulative record volume, birthday collisions become plausible far earlier than with a full UUID. Repository upserts can overwrite an existing same-production record or confuse correlation/audit linkage. These IDs are not authentication secrets, so the issue is reliability and forensic integrity rather than direct token guessing.
- **Recommended remediation:** Retain a full UUID/UUIDv7 or at least 96-128 random bits, and enforce unique constraints with collision retry for every persisted identifier.

## Cross-domain conclusions

- **Application security:** Strong strict schemas and a closed write-operation union exist, but identity and authorization are absent at the public API boundary. Approval checks validate data binding, not approver authority.
- **Architecture:** Domain/application separation is clear and mechanically reinforced by ESLint. The main production blockers are non-atomic control records, ephemeral workflow infrastructure, unsafe default file-store concurrency, and the lack of a defined deployment artifact.
- **Database security:** Structured Mongo queries avoid SQL/NoSQL string injection, and production snapshots are validated. Tenant key encoding, auxiliary-document validation, encrypted connection policy, backup/migration ownership, and atomic workflow transactions remain incomplete.
- **LLM/AI security:** The shipped runtime uses a deterministic rule adapter; Bedrock/Ollama are not wired. Model IDs and candidate sets are grounded and the model has no generic DB tool. The remaining material AI risk is schema-valid but misleading prose at the human approval boundary, plus future provider cancellation/privacy requirements.
- **Secrets and sensitive data:** No tracked credential/private-key file or embedded high-confidence secret was found. Environment configuration is used for Mongo credentials and is not logged directly at startup. Raw user text, local database permissions, raw exception propagation, and undefined retention create leakage risks.
- **Third-party integrations:** Runtime outbound integration is Mongo only; no request-controlled external URL, file upload, dynamic redirect, SQL query builder, OpenSearch, Bedrock, Ollama, SQS, or AWS client is wired. No concrete SSRF, unsafe redirect, upload, SQL injection, or generic tool-to-database path was found.
- **Frontend:** No direct `innerHTML`, `eval`, sanitizer bypass, or request-controlled URL redirect was found. Angular interpolation mitigates the reviewed stored-XSS paths. Authentication introduction must include cookie/CSRF or bearer-token design and retain explicit WebSocket Origin protection.
- **CI/CD and production:** CI exercises typecheck, lint, tests, build, and E2E, but does not enforce supply-chain/security gates. Production deployment, IAM, networking, TLS, secrets management, monitoring, backup, and rollback are described only as aspirations or deferred work.

## Verification evidence

- Tracked-file secret scan: no `.env`, PEM/private-key, credential file, or high-confidence API key/token pattern found. `.gitignore` excludes `.env` and `.env.*` while allowing a future `.env.example`.
- `pnpm audit --prod --json`: 131 production dependencies; 0 known vulnerabilities on 2026-09-11.
- `pnpm audit --json`: 769 total dependencies; 2 moderate entries for the same Vitest / `@vitest/mocker` vulnerable path described in AUD-018.
- MCP registry/security contract: 60/60 tests passed.
- WebSocket gateway: 13/13 tests passed when local port binding was allowed. These tests cover strict messages, allow-list rejection, heartbeat, and sequential subscription limits, but not authentication, Origin, payload/rate limits, or the concurrent subscription race.
- No source/configuration file was changed by this audit; only this numbered Markdown report was added under `docs/`.

## Recommended remediation sequence

1. Prevent any non-local deployment until AUD-001 is fixed and authorization defaults fail closed (AUD-003/007).
2. Make apply and decision transitions atomic (AUD-002/004), then correct tenant key isolation (AUD-005) and input-to-persistence validation (AUD-010).
3. Replace the default file/memory workflow components with concurrency-safe, durable production adapters and recovery procedures (AUD-006/009/013).
4. Add abuse controls, secure error handling, object binding, and model-output presentation controls (AUD-008/011/012/014).
5. Define and verify a hardened production artifact/IaC/database/observability baseline (AUD-015/016/021/024).
6. Upgrade the vulnerable toolchain and harden CI supply-chain controls (AUD-018/019), then address remaining low-severity resilience items.
