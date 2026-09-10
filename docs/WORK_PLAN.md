# Work Plan — Free-Tier Execution Order

Execution order for the AI Production Change Agent MVP, constrained to tools that cost nothing today.
Derived from `TASKS.md` (P0–P8) with two ordering adjustments (steps 5 and 13–14) so the golden
scenarios pass in-memory before any adapter is attached.

Last updated: 2026-09-10.

## 1. Constraint

No paid service and no AWS account may be required at any step. The documents already require
that local tests never touch live AWS, so the MVP (three golden scenarios) is fully achievable
for free. Only P7 infrastructure and live Bedrock/SQS connections are deferred.

## 2. Local environment (checked 2026-09-10)

| Item                              | Status                                |
| --------------------------------- | ------------------------------------- |
| node / npm / pnpm                 | present (v24 / 11 / 10)               |
| docker, mongod, ollama, terraform | absent                                |
| AWS credentials                   | absent                                |
| git remote                        | GitHub (`Trapa-Eureka/product_agent`) |

## 3. Paid item → free substitute

| Stack item                                                     | Cost                    | What we use instead                                                                                                     |
| -------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AWS Bedrock                                                    | per-token billing       | `FakeModelAdapter` only. Optional Ollama (local, free) adapter behind `ModelPort` if a live-LLM demo is wanted          |
| MongoDB                                                        | free                    | `mongodb-memory-server` for tests and local runs (no Docker). Homebrew community edition if a persistent DB is needed   |
| AWS SQS                                                        | needs account + card    | In-memory queue adapter only. SQS adapter deferred                                                                      |
| OpenSearch                                                     | expensive               | Excluded (optional for MVP per `ARCHITECTURE.md` §12)                                                                   |
| Terraform                                                      | CLI free, `apply` bills | Code + `terraform validate` only. No `plan`/`apply`                                                                     |
| GitLab CI                                                      | repo is on GitHub       | GitHub Actions (free for public repos) runs `verify`. `.gitlab-ci.yml` authored in parallel for portfolio, not executed |
| Angular, Express, MCP SDK, ws, zod, vitest, Playwright, ESLint | free                    | used as-is                                                                                                              |

## 4. Ordered steps

### Stage 1 — Foundation (P0)

1. TASK-001 Monorepo — **done**: pnpm workspaces, strict tsconfig, vitest, ESLint, root commands (`typecheck`, `lint`, `test`, `test:integration`, `test:contract`, `test:e2e`, `verify`) green with smoke tests.
2. TASK-002 `packages/contracts` — **done**: zod schemas (ChangeRequest, Impact, Proposal, Approval, MCP I/O, JobEvent) with valid/invalid cases.
3. TASK-003 `packages/domain` — **done**: entities and INV-1..INV-8. Enforce "no infrastructure imports" with a lint rule.
4. TASK-004 Demo Movie fixtures — **done**: stable IDs, integrity test asserting `TESTING.md` §3 preconditions.

### Stage 2 — Application core (P1), golden scenarios in-memory first

5. TASK-101 Repository ports + free adapters — **done**. Ports in `packages/application`, with in-memory and JSON file adapters under `packages/adapters`. Built before Mongo so steps 6-12 need no database.
6. TASK-103 Change intake use case — **done**. Confirms IDs against the production, persists raw sentence plus typed change, audit event, correlation ID.
7. TASK-104 Dependency impact engine. GOLDEN-1/2/3 impact sets must match exactly.
8. TASK-105 Candidate shoot-day generator (simple rules, no solver).
9. TASK-106 Simulation / validation (side-effect free).
10. TASK-107 Approval model (digest, version binding, stale detection).
11. TASK-108 Apply approved proposal (idempotency, version increment).
12. TASK-109 Post-write verification.
13. TASK-601 Golden scenario tests, pulled forward to application level. Regression baseline for every later step.
14. TASK-102 Mongo adapters via `mongodb-memory-server`. Run the same repository contract tests against in-memory and Mongo.

### Stage 3 — MCP (P2)

15. TASK-201 MCP server foundation (stdio transport, schema validation, context, logging).
16. TASK-202 Nine read tools.
17. TASK-203 Four analysis tools.
18. TASK-204 Proposal tools (create/get).
19. TASK-205 `apply_approved_proposal`. Critical: no approval = no mutation.
20. TASK-206 `verify_applied_proposal`.
21. TASK-207 + TASK-603 contract and security suites (`MCP.md` §10, `TESTING.md` §9).

### Stage 4 — AI orchestration (P3), free scope

22. TASK-301 `ModelPort`.
23. TASK-302 `FakeModelAdapter`: deterministic outputs for the three scenarios plus malformed JSON / hallucinated ID / timeout cases.
24. TASK-304 Change interpreter (NL → schema-validated typed change → entity resolution). Weekday resolution rule: see §6.
25. TASK-305 Orchestration (interpret → read → analyze → candidates → simulate → validate → explain → propose). No write before approval.
26. TASK-306 Explanation layer.
27. (Optional) Ollama adapter behind `ModelPort`, only if a live-LLM demo is wanted.

### Stage 5 — Async / realtime (P4)

28. TASK-401 Queue port + in-memory queue (retry, duplicate, terminal failure).
29. TASK-403 Job state machine (`SPEC.md` §7 stages).
30. TASK-404 WebSocket gateway (`ws`).
31. TASK-405 Reconnect: client recovers canonical state via REST.
32. TASK-602 Failure injection (stale version, provider failure, queue retry, partial failure).

### Stage 6 — API + UI (P5)

33. TASK-110 REST API routes in `apps/api` (production, change, proposal, approval, audit) with API tests. Added to `TASKS.md`; previously missing.
34. TASK-501 Angular shell.
35. TASK-502 Input / ambiguity resolution / detected-change card.
36. TASK-503 Impact panel (BLOCKING / AFFECTED / WHY).
37. TASK-504 Proposal comparison.
38. TASK-505 Approval flow (Reject / Approve & Apply with final confirmation).
39. TASK-506 Realtime progress timeline.
40. TASK-507 Schedule before/after view, TASK-508 Audit view.

### Stage 7 — E2E / CI (P6)

41. TASK-604 Playwright E2E, three scenarios (fake model + memory-server).
42. TASK-605 CI: GitHub Actions runs `verify`. `.gitlab-ci.yml` written with the same stages, not executed.

### Stage 8 — Portfolio polish (P8)

43. TASK-801 Seed/reset command.
44. TASK-804 Correlation IDs + timing instrumentation.
45. TASK-802 Architecture diagram, TASK-803 demo script, TASK-805 README.

## 5. Deferred (paid or AWS account required)

- TASK-303 Bedrock adapter: at most code + unit tests with a mocked SDK client. No live calls.
- TASK-402 SQS adapter: replaced by the in-memory queue. No live connection.
- TASK-701..703 Terraform: code + `terraform validate` only. No `plan`/`apply`.
- TASK-704 OpenSearch, TASK-705 deployment: excluded.

## 6. Decisions required before the affected step

- **Weekday resolution ("Friday"). Settled 2026-09-10: use the recommendation below.** Fixture Friday is 2026-09-18. Resolve a bare weekday against the production's shoot days, not the calendar; on multiple matches fall through to the ambiguity-resolution step in `DESIGN.md`. Tests inject a clock. (Affects step 24.)
- **"red car" requirement type. Settled 2026-09-10: `PROP`.** `SPEC.md` §5-C says PROP; `DOMAIN.md` allows PROP or VEHICLE. Use PROP. (Affects steps 7, 23.)
- **REST API task.** Added as TASK-110 (step 33).
- **CI platform.** GitHub Actions is the executed path; GitLab CI file is documentation-only. (Affects step 42.)

## 7. npm publishing — full functionality, zero cost

The original stack assumes a MongoDB server and a hosted LLM at runtime. A package that requires
those is not "install and run". Two adapters are swapped for the distribution; domain and
application code stay identical (`ARCHITECTURE.md` §17).

| Area                 | Documented stack     | npm distribution default                             | Note                                                 |
| -------------------- | -------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Store                | MongoDB              | JSON file store adapter                              | no native deps; `PCA_STORAGE=mongo` restores Mongo   |
| Model                | Bedrock              | Rule-based interpreter adapter; Ollama auto-detected | rules cover `SPEC.md` §5 patterns; `PCA_MODEL=ollama` or `bedrock` switches |
| Queue                | SQS                  | in-process queue                                     | retry/idempotency unchanged                          |
| UI                   | Angular              | unchanged, prebuilt static assets served by Express  | user needs no Angular CLI                            |
| API / realtime / MCP | Express, ws, MCP SDK | unchanged                                            |                                                      |
| Infra / CI           | Terraform, GitLab    | not part of the package                              |                                                      |

Shape: one package, one CLI, three subcommands.

```text
npx production-change-agent seed    # reset Demo Movie
npx production-change-agent serve   # API + UI + WebSocket
npx production-change-agent mcp     # stdio MCP server
```

Impact on the ordered steps:

- step 5 (TASK-101): done. JSON file adapter sits beside the in-memory one; one contract suite runs against both, and Mongo joins it in TASK-102.
- step 23 (TASK-302): add `RuleInterpreterAdapter` as the runtime default; `FakeModelAdapter` stays test-only.
- step 34 (TASK-501): Angular build output must be servable as static files from `apps/api`.
- step 45 adds TASK-806 with the acceptance test "clean machine + `npx` runs all three golden scenarios".

Honest limits: free-form sentences outside the rule patterns need a user-installed Ollama (free);
the file store is single-process.

Publishing a public package costs nothing; a free npm account and `npm login` are the only prerequisites.
The rationale for the free-first defaults is recorded in `ARCHITECTURE.md` §2 and `docs/decisions/0001-free-first-adapters.md`.
