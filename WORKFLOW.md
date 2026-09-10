# AI-Native Engineering Workflow

## 1. Objective

The repository is designed so coding agents can work for meaningful periods without continuous prompting while remaining bounded by explicit intent and fast verification.

The goal is not “maximum generated code.” The goal is **high-confidence autonomous execution**.

## 2. Responsibility split

```text
Human
  owns WHAT, WHY, priorities, risk acceptance, consequential approval

Agent
  owns bounded implementation decisions, code changes, local diagnosis,
  tests, and documentation updates within explicit constraints

Automated checks
  decide whether implementation satisfies executable expectations
```

## 3. Context before code

Before assigning implementation:
1. make product intent explicit;
2. update spec/design if needed;
3. define domain constraints;
4. define acceptance criteria;
5. ensure the agent knows how to verify itself.

Prefer iterating on a specification before generating broad code changes.

## 4. Feed agents, do not babysit

A good task gives the agent:
- goal;
- relevant docs;
- allowed scope;
- dependencies;
- acceptance criteria;
- commands;
- deterministic tests/mocks;
- stop conditions.

Avoid repeated micro-prompts such as:
- “now create this file”;
- “now fix that type”;
- “now run the test.”

The repository should let the agent discover and repair routine failures itself.

## 5. Shift testing left

For new behavior:

```text
spec / acceptance criteria
       ↓
fixture / contract / failing test where useful
       ↓
implementation
       ↓
local verification
       ↓
integration
```

External services must not block normal iteration.

Use:
- fake model adapter;
- fake/in-memory queue;
- deterministic fixtures;
- repository test adapters;
- optional local database/test container approach.

## 6. Parallel agents

Parallelize independent backlog items, not vague goals.

Good:
- Agent A: domain impact engine
- Agent B: Angular shell
- Agent C: Terraform SQS module

Bad:
- Agent A/B/C all “improve architecture”

Before parallel execution:
- stabilize shared contracts;
- assign file/package boundaries;
- state dependencies;
- avoid multiple agents editing the same core file.

After parallel execution:
- integrate;
- run root verification;
- resolve contract drift explicitly.

## 7. Task handoff template

```markdown
## Goal
...

## Context
Read:
- DOMAIN.md §...
- MCP.md §...

## Dependencies
...

## Allowed scope
- packages/domain/...
- packages/application/...

## Do not change
- public MCP schemas
- Angular app

## Acceptance criteria
- ...
- ...

## Required verification
npm run test -- ...
npm run typecheck
npm run verify

## Stop and ask if
- schema must change
- destructive migration required
```

## 8. Agent completion report

Every autonomous run should report:

```text
Task:
Status:

Changed:
- ...

Tests:
- command → result

Decisions:
- ...

Assumptions:
- ...

Risks / follow-up:
- ...
```

Do not accept “implemented successfully” without evidence.

## 9. Context pruning

Agent context becomes harmful when it contains stale or conflicting instructions.

Periodically:
1. inspect `CLAUDE.md`;
2. remove rules already enforced mechanically;
3. move detailed knowledge to focused docs;
4. remove obsolete architecture notes;
5. resolve contradictions;
6. keep the steering file small.

Prefer executable enforcement over prose:
- type system over “remember this shape”;
- lint rule over repeated style instructions;
- test over behavioral reminder;
- schema over prompt-only format requirements.

## 10. Error-message design

Errors are feedback to both humans and agents.

Bad:
```text
Something went wrong.
```

Good:
```text
PRODUCTION_VERSION_MISMATCH:
Proposal P-104 was simulated against version 12 but current version is 13.
Reload production state and re-run simulation before requesting approval.
```

Errors should contain:
- stable code;
- relevant IDs;
- expected/actual values where safe;
- next safe action.

## 11. Branch/commit strategy

Keep tasks small enough to review independently.

Suggested branch names:
```text
task/104-impact-engine
task/205-approved-proposal
task/504-proposal-ui
```

Commits should reflect coherent changes rather than every agent iteration.

Never let an autonomous agent push to production or merge protected branches without the repository's explicit human-controlled policy.

## 12. Review strategy

Review in this order:
1. requirement/acceptance match;
2. security/approval boundaries;
3. domain correctness;
4. tests/negative cases;
5. architecture boundaries;
6. maintainability;
7. style.

Generated code receives the same review standard as handwritten code.

## 13. Decision records

When a material architecture choice is made, capture:
- context;
- options;
- decision;
- consequences.

Examples:
- Why high-level `apply_approved_proposal` instead of granular write tools?
- Why MongoDB relationships remain explicit rather than heavily embedded?
- Why OpenSearch is excluded from deterministic dependency resolution?

A future `docs/decisions/` ADR directory can hold these.

## 14. Human approval in the product vs development workflow

Do not confuse the two:

**Product approval:** production coordinator approves a proposed production mutation.

**Development approval:** repository owner controls merges, credentials, destructive infrastructure, and production deployment.

Both remain human-controlled.

## 15. Frontier-style success criteria

The workflow is working when:
- agents can complete well-scoped tasks without continuous chat;
- multiple independent tasks can run in parallel;
- failures are diagnosed through tests/errors rather than human explanation;
- context files remain concise and current;
- the human spends more time on product intent, architecture, review, and prioritization than typing implementation code.

Autonomy without constraints is not the goal. **Autonomy with explicit intent, deterministic feedback, and safe capability boundaries is.**
