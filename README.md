# AI Production Change Agent

**MCP-powered production workflow assistant**

An independent portfolio project inspired by connected film/video production workflows. The system analyzes how a change to cast, locations, scenes, or schedules affects the rest of a production, proposes safe alternatives, and applies only human-approved changes through explicit MCP tools.

> This is not a StudioBinder product and does not use StudioBinder proprietary code, data, UI, or assets.

## Product thesis

Production data is connected:

```text
Script / Scene
   ├─ Cast
   ├─ Location
   ├─ Props / Requirements
   ↓
Schedule
   ↓
Call Sheet
   ↓
Tasks
```

A change to one node can propagate across the workflow. The useful AI behavior is therefore not merely chat. It is **dependency-aware change analysis + safe action**.

## Core workflow

```text
User change request
        ↓
Interpret intent
        ↓
Read production state via MCP
        ↓
Deterministic dependency analysis
        ↓
Simulate candidate changes
        ↓
Validate constraints
        ↓
Explain impact and proposal
        ↓
Human approval
        ↓
Apply via MCP write tools
        ↓
Verify result + audit
```

## MVP scenarios

1. **Cast unavailable**
   - “Sarah cannot shoot Friday.”
   - Find affected scenes, schedule entries, call sheets, and tasks.
   - Propose valid alternatives.

2. **Location unavailable**
   - “The warehouse is unavailable Friday.”
   - Find all scenes scheduled there and downstream effects.
   - Propose rescheduling or replacement-location options.

3. **Scene requirement changed**
   - “Scene 18 now needs a red car.”
   - Update the proposed breakdown, identify prop/task implications, and flag schedule/call-sheet effects.

## Target stack

| Layer | Technology |
|---|---|
| Frontend | Angular + TypeScript |
| API | Node.js + Express + TypeScript |
| Database | MongoDB |
| AI | Provider adapter; AWS Bedrock target |
| Search/RAG | OpenSearch, optional for MVP |
| Async jobs | AWS SQS |
| Realtime | WebSocket |
| Agent tools | MCP |
| Infrastructure | Terraform |
| CI/CD | GitLab CI |
| Tests | Unit, integration, MCP contract, E2E |
| Local cloud dependencies | Deterministic mocks/adapters |

The stack intentionally exercises technologies relevant to the target engineering role. Local development must not require live AWS credentials.

## Engineering principles

- Human decides consequential changes.
- LLM interprets intent and explains proposals.
- Deterministic code calculates dependencies and validates invariants.
- MCP is the controlled capability boundary.
- No direct LLM-to-database writes.
- Every mutation is auditable.
- Tests and local mocks are created early.
- Agent context is explicit and pruned when stale.

## Documentation

Read in this order:

1. `CLAUDE.md`
2. `SPEC.md`
3. `DOMAIN.md`
4. `DESIGN.md`
5. `ARCHITECTURE.md`
6. `MCP.md`
7. `TESTING.md`
8. `TASKS.md`
9. `WORKFLOW.md`

## Non-goals

- Rebuilding a complete production-management platform
- Copying StudioBinder UX or proprietary behavior
- Autonomous high-impact production decisions without approval
- Direct database access by an LLM
- Making an LLM the source of truth for deterministic scheduling/dependency rules
- Billing, enterprise administration, or full screenplay editing
- Storyboard/image generation in the initial MVP

## Definition of success

A clean checkout can run locally with deterministic fixtures and mock external services. The three MVP scenarios work end-to-end. The agent can read, analyze, simulate, and propose changes; mutations require explicit approval; MCP contracts and domain invariants are tested; and the repository contains enough context and automated feedback for coding agents to complete bounded tasks with minimal human interaction.
