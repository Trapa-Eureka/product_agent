# Agent Steering Guide

This is the primary steering file for coding agents. Keep it concise and operational. Detailed product/domain knowledge belongs in the linked documents. Remove stale rules rather than accumulating exceptions.

## Mission

Build the **AI Production Change Agent**, an MCP-powered assistant that understands downstream production dependencies and safely applies human-approved changes.

## Read before coding

- Product requirements: `SPEC.md`
- Domain model/invariants: `DOMAIN.md`
- UX/interaction: `DESIGN.md`
- Architecture: `ARCHITECTURE.md`
- MCP contracts: `MCP.md`
- Verification: `TESTING.md`
- Backlog: `TASKS.md`
- Human/agent process: `WORKFLOW.md`

If intent is unclear, improve the specification before scattering assumptions through code.

## Non-negotiable rules

1. Use TypeScript for frontend, backend, MCP server, and shared contracts.
2. Keep domain logic framework-independent.
3. Angular, Express, MongoDB, Bedrock, SQS, OpenSearch, and MCP are adapters around domain/application logic.
4. The LLM may interpret natural language, rank options, and explain results.
5. Deterministic code owns dependency traversal, constraint checks, IDs, authorization, approval state, and mutations.
6. The LLM never receives raw database credentials.
7. The LLM never performs arbitrary MongoDB queries or writes.
8. Consequential writes must follow:

```text
READ → ANALYZE → SIMULATE → VALIDATE → PROPOSE → APPROVE → WRITE → VERIFY
```

9. No write operation is allowed without an explicit approval record/token bound to the proposal.
10. Write operations must be idempotent where practical.
11. Every accepted/rejected proposal and mutation must be auditable.
12. External services require deterministic local adapters/mocks.
13. Tests are part of implementation, not a later phase.
14. Do not weaken tests merely to make them pass.
15. Prefer explicit types, small modules, clear names, and actionable errors.
16. Never copy StudioBinder code, UI, text, assets, or proprietary data.

## Task execution loop

For each task:

1. Read the task, acceptance criteria, and relevant docs.
2. Inspect existing implementation and tests.
3. Identify the smallest coherent change.
4. Implement within documented boundaries.
5. Add/update tests.
6. Run focused checks.
7. Run the repository verification gate.
8. Fix failures before declaring completion.
9. Report changed files, tests run, assumptions, and remaining risks.

Do not ask the human about ordinary implementation details already constrained by the docs.

Stop and request a human decision when:
- two specifications conflict;
- a destructive migration is required;
- production credentials/access are needed;
- a security or approval boundary must change;
- a product decision has multiple materially different user outcomes.

## Target root commands

Foundation tasks should provide these commands:

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

`npm run verify` is the local completion gate and must work without live AWS resources.

## Context hygiene

- Durable business rules → `DOMAIN.md`
- User-visible requirements → `SPEC.md`
- UX decisions → `DESIGN.md`
- System boundaries → `ARCHITECTURE.md`
- Tool contracts → `MCP.md`
- Verification rules → `TESTING.md`
- Work state → `TASKS.md`
- Process → `WORKFLOW.md`

Do not place long logs, temporary prompts, generated summaries, or outdated instructions here.

## Completion standard

A task is not complete because code was generated. It is complete only when its acceptance criteria are met and automated verification passes.
