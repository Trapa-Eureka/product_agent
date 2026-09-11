# Comprehensive Security Review

- Review date: 2026-09-11 (Asia/Manila)
- Reviewed revision: `c6ddb4ee9b4cbc55e826fd2703dbe003a2a3b626`
- Scope: the entire repository, including REST/MCP/WebSocket boundaries, application and domain guardrails, persistence adapters, Angular UI, environment/configuration, CI, tests, and the complete dependency lockfile
- Method: manual source and trust-boundary review, tracked-secret pattern scan, focused security/contract tests, and `pnpm audit` against the current npm advisory database

## Findings

### Critical

#### SEC-001 — The REST API has no authentication, and a caller can forge the human approver identity and apply a consequential mutation

- **Files:** `apps/api/src/app.ts`; `apps/api/src/main.ts`; `packages/application/src/use-cases/decide-proposal.ts`
- **Lines:** `apps/api/src/app.ts` 53-56, 85-91, 199-210, 377-457; `apps/api/src/main.ts` 74-87; `packages/application/src/use-cases/decide-proposal.ts` 141-177
- **Problem:** The API accepts every request without authenticating it. It treats the caller-controlled `X-Actor-Id` header as the authenticated user, writes that value into `approvedBy`/audit records, exposes the human-only decision endpoint, and then exposes the apply endpoint. The production allow-list constrains only the production ID; it neither establishes identity nor grants a role. A caller that can reach the API and knows a production/proposal ID can submit `APPROVE`, receive a valid approval ID, and immediately apply the proposal under any claimed identity.
- **Why it matters:** This bypasses the project's central human-approval security boundary in substance: an approval record exists, but there is no proof that a human or authorized approver created it. It enables unauthorized production reads, proposal creation, self-approval, mutation, audit forgery, and repudiation. Binding to loopback by default reduces remote exposure but does not protect a shared host, container network, reverse proxy deployment, or a deployment configured with `PCA_API_HOST=0.0.0.0`.
- **Recommended fix:** Put mandatory authentication in front of every non-health REST route and the WebSocket upgrade. Validate a signed OIDC/JWT or server-side session and derive the actor ID exclusively from verified claims; never accept identity from `X-Actor-Id` unless a trusted proxy strips and re-adds it over an authenticated internal hop. Enforce server-side RBAC/ABAC per production and per operation. Require a distinct approver permission, and preferably maker-checker separation so the proposer/requester cannot approve their own consequential proposal. Record immutable authenticated subject, issuer, role, and authentication context in the approval/audit record.

### High

#### SEC-002 — Authorization fails open to every production when the allow-list is absent, blank, or `*`

- **Files:** `apps/mcp-server/src/context.ts`; `apps/api/src/server.ts`; `apps/api/src/main.ts`
- **Lines:** `apps/mcp-server/src/context.ts` 13-16, 21-38; `apps/api/src/server.ts` 31-37; `apps/api/src/main.ts` 74-95
- **Problem:** `contextFromEnv` maps an unset or blank `PCA_ALLOWED_PRODUCTIONS` to `"*"`. The same context protects REST, MCP, and WebSocket access, so an ordinary omission in deployment configuration grants access to all production IDs rather than denying startup or access.
- **Why it matters:** A missing environment variable is a common deployment failure. Here it silently becomes maximum privilege and compounds SEC-001: any reachable client can enumerate or mutate any known production. It also contradicts the source comment that wildcard is only for local demos without technically enforcing a demo mode.
- **Recommended fix:** Default to an empty allow-list and fail startup when the allow-list is missing outside an explicit `PCA_DEMO_MODE=true`. Parse every listed ID with `entityIdSchema`, reject empty results and wildcard in production, and log a high-visibility startup failure rather than continuing. Prefer authorization derived from the authenticated principal's server-side grants instead of a process-global list.

#### SEC-003 — WebSocket upgrades authenticate neither the client nor its Origin, enabling cross-site access to a local or exposed API

- **Files:** `apps/api/src/server.ts`; `packages/adapters/ws-gateway/src/index.ts`
- **Lines:** `apps/api/src/server.ts` 27-39; `packages/adapters/ws-gateway/src/index.ts` 34-46, 100-107, 170-181, 217-228
- **Problem:** The upgrade handler accepts any request whose path is `/ws`; it does not verify a token, session, `Origin`, `Host`, or an application protocol. Subscription authorization checks only the process-wide production allow-list. Browsers can open WebSockets cross-origin even though ordinary cross-origin JSON requests would be constrained by CORS preflight.
- **Why it matters:** A malicious web page can connect to a developer's loopback service and subscribe to a known/default production, or a network client can connect to an externally bound service. It can receive job stages, proposal IDs, summaries, validation state, and related production metadata. Once real cookie authentication is added, the same omission becomes cross-site WebSocket hijacking unless fixed at the upgrade boundary.
- **Recommended fix:** Authenticate during upgrade using a short-lived, audience-bound token or a secure server session; authorize subscriptions against that principal. Enforce an exact Origin allow-list for browser clients, validate `Host`/forwarded-host according to the trusted proxy topology, and reject unauthorized upgrades with HTTP 401/403 before `handleUpgrade`. Add negative tests for foreign/missing Origin and missing/invalid credentials.

#### SEC-004 — Proposal decision finality is a non-atomic read-then-write and allows concurrent approve/reject decisions

- **Files:** `packages/application/src/use-cases/decide-proposal.ts`; `packages/adapters/mongo-store/src/index.ts`; `packages/adapters/memory-store/src/index.ts`; `packages/adapters/file-store/src/index.ts`
- **Lines:** `decide-proposal.ts` 59-87, 141-177; `mongo-store/src/index.ts` 155-167, 380-401; `memory-store/src/index.ts` 117-129; `file-store/src/index.ts` 197-219
- **Problem:** The use case first queries for an existing approval and later performs three independent saves. Two concurrent requests can both observe no decision, generate different approval IDs, and persist opposite decisions. Mongo's `(productionId, proposalId)` index is not unique, while memory/file stores also allow multiple approval records for one proposal. The proposal status is a separate last-writer-wins update.
- **Why it matters:** The system can contain both an approval and a rejection for the same proposal, while lookup behavior and proposal status disagree. An approve record may remain usable by the write guard when the intended final human action was rejection, directly weakening approval guardrails and the evidentiary value of the audit trail.
- **Recommended fix:** Introduce one atomic `recordProposalDecision` repository operation. Enforce a unique `(productionId, proposalId)` constraint, compare-and-set the proposal from `AWAITING_APPROVAL`, create exactly one decision, and append its audit event in one transaction/serialized file mutation. Treat duplicate-key/CAS loss as the already-recorded winning decision. Add simultaneous APPROVE/REJECT tests to every repository adapter.

#### SEC-005 — The consequential mutation, replay protection, proposal state, and audit evidence are not committed atomically

- **File:** `packages/application/src/use-cases/apply-approved-proposal.ts`
- **Lines:** 249-290
- **Problem:** The production mutation commits at line 255, then the idempotency record, `APPLIED` proposal status, and audit event are written separately at lines 278-280. A crash or repository failure between these operations leaves the protected business change applied without some or all of its control records. A retry can then fail on the advanced production version before reconstructing the successful result.
- **Why it matters:** Security controls that exist only before the write are insufficient if the post-write evidence and replay record can disappear. This creates unaudited mutations, false failure responses, proposals that still look applicable, and retries that cannot safely converge. It violates the project's write/audit/idempotency guardrails at the most sensitive boundary.
- **Recommended fix:** Commit the version-checked production mutation, idempotency insert, proposal transition, and audit append as one storage transaction/unit of work. Mongo can use a transaction; the file adapter can perform one validated read-modify-write. If a distributed transaction is unavoidable later, use a durable operation/outbox record and a recovery state machine that can prove and reconcile the post-state before retrying.

#### SEC-006 — Unvalidated actor and correlation headers can persist schema-invalid records and permanently break the default file store

- **Files:** `apps/api/src/app.ts`; `apps/mcp-server/src/context.ts`; `packages/application/src/use-cases/submit-change-request.ts`; `packages/contracts/src/primitives.ts`; `packages/contracts/src/change.ts`; `packages/adapters/file-store/src/index.ts`
- **Lines:** `apps/api/src/app.ts` 80-91, 175-190; `apps/mcp-server/src/context.ts` 21-33; `submit-change-request.ts` 67-94, 119-146; `primitives.ts` 59-63; `change.ts` 70-80; `file-store/src/index.ts` 269-333
- **Problem:** `X-Correlation-Id` and `X-Actor-Id` are trimmed but never parsed or length-limited. `PCA_ACTOR_ID` is likewise unvalidated. Downstream persisted contracts allow at most 128 characters for a correlation ID and 200 for an actor. The file store validates only on read, not before write, so a request can successfully write an invalid change request; the following operation and every later read then fail with `STORE_CORRUPT`.
- **Why it matters:** Any reachable unauthenticated caller can turn a single request into persistent denial of service and corrupt audit identity/tracing. Because the invalid file becomes the source of truth, restart does not recover it. This is also a trust-boundary violation of the project's requirement that external inputs be schema validated.
- **Recommended fix:** Define and apply strict Zod schemas to both headers before creating the call context; generate a new correlation ID rather than accepting an invalid one. Derive actor identity from authentication and validate environment-derived identities at startup. Validate every record and the complete next `FileDatabase` before the temporary file is renamed, so invalid writes leave the prior database intact. Apply save-time schemas consistently to memory and Mongo adapters as defense in depth.

#### SEC-007 — WebSocket and REST resource controls permit cheap unauthenticated denial of service

- **Files:** `packages/adapters/ws-gateway/src/index.ts`; `apps/api/src/app.ts`; `packages/contracts/src/change.ts`; `packages/contracts/src/mcp.ts`; `packages/contracts/src/proposal.ts`
- **Lines:** `ws-gateway/src/index.ts` 66-68, 82-107, 126-168, 170-181, 217-228; `apps/api/src/app.ts` 171-174, 308-341, 460-501; `change.ts` 48-52; `mcp.ts` 176-180, 223-227, 256-262; `proposal.ts` 23-28, 97-105
- **Problem:** There is no connection, per-IP/principal, message-rate, request-rate, or expensive-operation limiter. `WebSocketServer` is constructed without `maxPayload`; the installed `ws` default is 100 MiB, after which the code converts the full frame to text, parses JSON, and validates it. Several externally reachable arrays have only `.min(1)` and no `.max()`, allowing a 256 KiB HTTP body to drive thousands of scene IDs/operations through analysis and simulation.
- **Why it matters:** An unauthenticated client can consume large amounts of memory/CPU, open many heartbeat-managed sockets, enqueue many model/analysis jobs, and grow in-memory job/audit state. The HTTP body limit is useful but does not address request frequency or computational amplification; the WebSocket default is roughly 400 times larger.
- **Recommended fix:** Set a small explicit WebSocket `maxPayload` appropriate to the three tiny client messages, cap concurrent connections and messages per principal/IP, and close abusive clients. Add global and route-specific rate limits, queue/backpressure limits, bounded job retention, request timeouts, and maximum array/cardinality constraints based on production size. Charge expensive analysis/model calls to authenticated quotas and return 429 with retry guidance.

### Medium

#### SEC-008 — A caller can attach an approved proposal or rejection to an unrelated job in the same production

- **Files:** `apps/api/src/app.ts`; `packages/application/src/jobs/handlers.ts`
- **Lines:** `apps/api/src/app.ts` 394-409, 414-457, 460-500; `packages/application/src/jobs/handlers.ts` 175-220
- **Problem:** Decision and apply routes verify only that the supplied `jobId` exists in the same production. They do not require `run.proposalId === proposalId`, the expected job type/stage at enqueue time, or ownership by the authenticated requester. The apply handler also never checks that the run's recorded proposal matches the payload before advancing it.
- **Why it matters:** A caller can complete another proposal's job as “rejected,” or use any awaiting-approval job as the timeline for a different approved proposal. This corrupts canonical workflow state and realtime/audit interpretation, and becomes a horizontal privilege-escalation path as soon as jobs belong to different users or teams.
- **Recommended fix:** Bind job, change request, proposal, requester/tenant, and approval explicitly. At both the HTTP boundary and queue handler, require the expected job type, exact `proposalId`, `awaiting_approval` stage, and authorization over that job. Make the transition an atomic compare-and-set and reject mismatches without changing either job.

#### SEC-009 — Model-authored prose is schema-valid but not grounded, so prompt injection or a compromised model can influence the approver

- **Files:** `packages/application/src/ports/model.ts`; `packages/application/src/use-cases/run-change-agent.ts`; `packages/contracts/src/explanation.ts`
- **Lines:** `model.ts` 18-26, 72-121, 202-238; `run-change-agent.ts` 212-223, 283-289, 400-414; `explanation.ts` 27-34
- **Problem:** The model guard grounds interpretation IDs and requires candidate IDs to be a permutation, but `explainImpact` only parses an arbitrary 1-2000 character string. That prose is placed into the proposal narrative shown to the human approver and persisted in job/proposal data. Ranking `reason` text is similarly unconstrained beyond shape. There is no check that claims in these strings are entailed by deterministic impacts, conflicts, warnings, or operations, nor is the UI contract explicit that the narrative is untrusted model output.
- **Why it matters:** Prompt-injected user text or a compromised external provider can produce persuasive false claims such as “no conflicts” or “already authorized.” It cannot directly add an operation, which is a strong control, but it can socially engineer the human at the approval boundary—the exact place where untrusted output has the most leverage. This conflicts with comments claiming the narrative is grounded.
- **Recommended fix:** Treat model prose as untrusted presentation data. Prefer deterministic templates for all approval-critical claims; if narrative remains, label and visually separate it, prohibit security/authorization assertions, and ensure the confirmation view foregrounds exact deterministic operations, conflicts, version, and digest. Consider generating narrative from a closed set of fact references and validating every reference against the input rather than accepting free text. Add adversarial prompt tests for misleading but schema-valid prose.

#### SEC-010 — The default JSON database is created with ambient umask permissions despite containing sensitive production and audit data

- **Files:** `packages/adapters/file-store/src/index.ts`; `packages/application/src/use-cases/submit-change-request.ts`
- **Lines:** `file-store/src/index.ts` 49-55, 323-329; `submit-change-request.ts` 119-146
- **Problem:** The default store writes the entire database—including cast/location schedules, raw change text, identities, proposals, approvals, and audit records—to a temporary file without an explicit mode, then renames it. The directory also uses default permissions. On a typical `022` umask this produces a `0755` directory and `0644` data file readable by other local users.
- **Why it matters:** Production plans and human-entered change descriptions can be confidential. On developer workstations, shared servers, CI runners, or incorrectly isolated containers, unrelated local principals may read the database without going through authorization.
- **Recommended fix:** Create the data directory with mode `0700`, temporary/final files with `0600`, verify ownership and permissions at startup, and safely tighten existing files. Document that the file adapter is single-user only and use an encrypted/managed data store for multi-user deployment. Avoid following unsafe symlinks and validate the configured path against deployment policy.

#### SEC-011 — Raw user text is duplicated indefinitely in change requests and audit metadata without classification, redaction, or retention controls

- **Files:** `packages/application/src/use-cases/submit-change-request.ts`; `apps/api/src/app.ts`; `apps/web/src/app/pages/audit-format.ts`
- **Lines:** `submit-change-request.ts` 24-25, 119-146; `apps/api/src/app.ts` 524-540, 569-582; `audit-format.ts` 46-54
- **Problem:** The full user sentence is stored both as `ChangeRequest.rawText` and as audit metadata, then returned by read/audit endpoints and rendered. There is no data classification, secret/PII warning, redaction, field-level access control, or retention/deletion policy.
- **Why it matters:** Users may paste contact data, unreleased production details, credentials, or other secrets. Duplication expands the exposure and backup footprint, while SEC-001 makes reads unauthenticated. Even after authentication is fixed, broad audit readers may not need the original free text.
- **Recommended fix:** Define allowed/sensitive data policy at intake, warn users not to submit secrets, detect/redact high-confidence credentials before persistence, and avoid duplicating raw text in audit metadata—store a reference or digest instead. Apply least-privilege access to raw requests, encryption at rest where required, retention limits, and auditable deletion/redaction procedures.

#### SEC-012 — The locked test toolchain contains a disclosed arbitrary-file-read vulnerability

- **Files:** `package.json`; `pnpm-lock.yaml`
- **Lines:** `package.json` 28-43; `pnpm-lock.yaml` 53-55, 2043-2050, 3777-3787, 5421-5427, 7330-7353
- **Problem:** The root dependency resolves to `vitest@3.2.7` and `@vitest/mocker@3.2.7`. The 2026-09-11 `pnpm audit` reports GHSA-82fw-gwwq-j7x9 / CVE-2026-84373 (moderate): reachable Vite/Vitest mocker configurations can register a redirect outside the project root and read local files. The production-only audit reports zero vulnerabilities; the finding is confined to the development/test toolchain.
- **Why it matters:** If a developer or CI environment exposes an affected dev server/WebSocket, an attacker may read source, `.env` files, credentials, or other files accessible to that process. Development dependencies execute with developer/CI privileges and are part of the supply-chain trust boundary.
- **Recommended fix:** Upgrade the root Vitest dependency to `>=4.1.11` and regenerate the frozen lockfile, then rerun the full suite and `pnpm audit`. Until upgraded, never expose test/dev servers beyond loopback or place secrets in the workspace. Add automated dependency update/advisory checks to CI with an explicit policy for development dependencies.

#### SEC-013 — The asynchronous subscription check allows the per-connection subscription cap to be raced

- **File:** `packages/adapters/ws-gateway/src/index.ts`
- **Lines:** 126-168, 180-182
- **Problem:** Each socket message invokes `handleMessage` without sequencing. Multiple subscribe messages can all read `subscriptions.size` below the limit, suspend at `await authorize(...)`, and then each add a distinct production after authorization resolves. The existing test sends subscriptions sequentially and does not exercise this race.
- **Why it matters:** The advertised cap is a resource and data-minimization guard. A client can bypass it, broaden the stream it receives, and increase publish-time work for every notification. A slow or external authorization function makes exploitation easier.
- **Recommended fix:** Serialize message processing per connection, or reserve a slot before awaiting authorization and release it on failure. Re-check the cap after the await inside a per-client mutex. Add a test that sends more than the limit without waiting for acknowledgements while authorization is deliberately delayed.

### Low

#### SEC-014 — Model timeouts do not cancel provider work

- **Files:** `packages/application/src/ports/model.ts`; `packages/bootstrap/src/index.ts`
- **Lines:** `model.ts` 123-180; `bootstrap/src/index.ts` 178-189
- **Problem:** Timeout enforcement uses `Promise.race`, which rejects the application call but does not abort the underlying provider request. Current Ollama/Bedrock adapters are not wired, so the shipped rule adapter is not remotely exploitable through this path today.
- **Why it matters:** When an external provider is added, timed-out requests can keep sockets, memory, provider concurrency, and paid tokens active. Repeated calls—especially without SEC-007's rate limits—can exhaust resources while the API believes work has ended.
- **Recommended fix:** Add `AbortSignal` to `ModelPort`, create an `AbortController` per call, and abort the provider request on timeout or client/job cancellation. Bound provider concurrency and verify via a test that the adapter observes cancellation.

#### SEC-015 — Mongo validates production snapshots but trusts workflow/audit documents through unchecked type assertions

- **File:** `packages/adapters/mongo-store/src/index.ts`
- **Lines:** 100-104, 219-227, 340-442
- **Problem:** Production state is parsed with `productionStateSchema`, but change requests, proposals, approvals, audit events, and idempotency records are returned using `fromRow<T>`/casts without their Zod schemas. This differs from the file store, which validates the complete database on every read.
- **Why it matters:** A partial migration, operator edit, older writer, or storage corruption can introduce malformed authorization/workflow records that reach guards and UI as if TypeScript had validated them. Most malformed approvals fail closed, but the inconsistent boundary can still cause crashes, misleading status, or unreliable audit evidence.
- **Recommended fix:** Parse each Mongo document with its corresponding strict schema on read and validate before write. Add a schema for the persisted idempotency row and convert parse failures to a stable `STORE_CORRUPT` infrastructure error without returning raw document content.

#### SEC-016 — CI actions are referenced by mutable major-version tags

- **File:** `.github/workflows/ci.yml`
- **Lines:** 25-30
- **Problem:** `actions/checkout@v4`, `pnpm/action-setup@v4`, and `actions/setup-node@v4` are mutable tag references rather than immutable commit SHAs.
- **Why it matters:** A compromised upstream release/tag can change code executed with CI permissions. The frozen package lockfile does not protect GitHub Actions.
- **Recommended fix:** Pin every action to a reviewed full commit SHA and use Dependabot/Renovate to propose controlled SHA updates. Minimize workflow token permissions explicitly with top-level/job-level `permissions`, and retain provenance review for action updates.

#### SEC-017 — HTTP responses lack an explicit security-header policy

- **Files:** `apps/api/src/app.ts`; `apps/api/src/server.ts`
- **Lines:** `apps/api/src/app.ts` 171-174; `apps/api/src/server.ts` 27-39
- **Problem:** The app disables `X-Powered-By` but does not set Content Security Policy, `X-Content-Type-Options`, frame restrictions, Referrer Policy, HSTS for TLS deployments, or cache controls for sensitive API responses. Angular interpolation currently prevents the reviewed stored text paths from becoming direct HTML injection, and no `innerHTML`/sanitizer bypass was found.
- **Why it matters:** These headers are defense in depth against content sniffing, clickjacking, data caching, and future XSS regressions. Their absence is lower risk while the API returns JSON and the UI is served separately, but a production reverse proxy must not leave the policy implicit.
- **Recommended fix:** Define security headers centrally (for example with a carefully configured Helmet policy or at the trusted reverse proxy), add `Cache-Control: no-store` to sensitive responses, deploy only behind TLS, and test the final deployed headers. Tailor CSP to the Angular build rather than enabling unsafe inline/script allowances broadly.

## Guardrail assessment

The repository contains no literal identifiers named “guardrail 1”, “guardrail 2”, or “guardrail 4”. To avoid inventing a separate policy, this review mapped the request to the enforceable project rules most closely governing the named risks: `CLAUDE.md` rules 4-5 (the LLM's narrow role and deterministic ownership of IDs/authorization/approval/mutations), rule 9 (a bound approval is mandatory), `SPEC.md` 194-211, and the MCP safety sequence in `MCP.md` 9-54.

- **LLM scope / deterministic ownership:** Strong structural controls exist: strict schemas, grounded entity IDs, a closed operation union, deterministic simulation, digest binding, and one MCP write tool. SEC-009 is the material gap: free-form narrative is not grounded even though it reaches the human decision point.
- **Authorization ownership:** Production scoping exists in repositories and tool handlers, and focused cross-production tests pass. SEC-001, SEC-002, SEC-003, and SEC-008 show that identity, default grants, realtime authentication, and object-to-object authorization are not yet enforced strongly enough for deployment.
- **Approval-before-write:** Digest/version/decision checks in `checkWriteAllowed` are well designed and reject missing, stale, mismatched, or tampered approvals. SEC-001 makes the decision issuer forgeable; SEC-004 permits contradictory decisions; SEC-005 can separate a committed write from its replay/audit evidence.

## Review coverage and verification

- Inspected all source, configuration, schema, adapter, UI, test, and documentation files relevant to authentication/authorization, environment and secret handling, trust boundaries, persistence, external calls, realtime transport, model I/O, and consequential writes.
- No tracked `.env`, key, credential, or private-key file was found; pattern scanning found no embedded secret. Mongo credentials are accepted from `PCA_MONGO_URI`, and startup logging records only the selected storage kind rather than the URI.
- No SQL layer or raw query construction exists. Mongo filters and updates use structured driver objects; no user-controlled Mongo operator object is accepted.
- No file-upload route, dynamic redirect, request-controlled outbound HTTP call, generic database command, `eval`/`Function`, `innerHTML`, or Angular sanitizer bypass was found. Consequently no concrete SQL injection, SSRF, unsafe redirect, upload, or direct XSS finding is reported.
- Cookie/session authentication is not implemented, so classic cookie-based CSRF is not currently the mutation mechanism. When browser credentials are added, use `SameSite` cookies plus CSRF protection for state-changing HTTP routes and retain strict Origin checks for WebSockets.
- `pnpm audit --prod --json`: 131 production dependencies, 0 known vulnerabilities.
- `pnpm audit --json`: 769 total dependencies, 2 moderate advisory entries representing Vitest and its vulnerable `@vitest/mocker` path (SEC-012).
- `apps/mcp-server/test/registry-and-security.contract.test.ts`: 60/60 passed.
- `packages/adapters/ws-gateway/test/ws-gateway.test.ts`: 13/13 passed when local port binding was permitted. The initial sandboxed run failed only because the environment denied `127.0.0.1` listen; it was rerun successfully with local binding permission.

## Remediation order

1. Block deployment until SEC-001 is fixed; implement authenticated identity, per-production authorization, and a real approver role.
2. Change authorization defaults and secure WebSocket upgrade/origin handling (SEC-002/003), then add rate/connection/payload limits (SEC-007).
3. Make decision and application state transitions atomic (SEC-004/005) and validate actor/correlation inputs plus file-store writes (SEC-006).
4. Bind jobs to proposals and principals (SEC-008), constrain untrusted model prose (SEC-009), and protect/limit retained data (SEC-010/011).
5. Upgrade Vitest immediately, then address the remaining defense-in-depth items.
