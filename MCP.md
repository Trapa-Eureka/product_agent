# MCP Tool Design

## 1. Purpose

MCP provides a narrow, typed capability surface between the AI agent and production application.

It is not a generic database shell.

## 2. Safety model

Tools are divided into:

1. **Read**
2. **Analyze / Simulate**
3. **Write**

Normal sequence:

```text
READ
 ↓
ANALYZE
 ↓
SIMULATE
 ↓
VALIDATE
 ↓
PROPOSE
 ↓
HUMAN APPROVAL
 ↓
WRITE
 ↓
VERIFY
```

The server enforces this sequence for consequential writes.

## 3. General tool requirements

Every tool:
- has a strict input schema;
- has a strict structured output;
- receives production/user context server-side;
- validates entity ownership;
- emits an audit/tool event;
- returns actionable errors;
- never exposes secrets or raw DB access.

Write tools additionally require:
- proposal ID;
- approval reference/token;
- expected production version;
- idempotency key.

## 4. Read tools

### `get_production`

Input:
```ts
{ productionId: string }
```

Output:
```ts
{
  id: string;
  name: string;
  timezone: string;
  version: number;
}
```

### `get_scene`

Input:
```ts
{ productionId: string; sceneId?: string; sceneNumber?: string }
```

Returns normalized scene plus required cast/location/requirements.

### `find_cast`

Input:
```ts
{ productionId: string; query: string }
```

Used for entity resolution. Returns candidate IDs/names only from the production.

### `get_cast_availability`

Input:
```ts
{ productionId: string; castId: string; from: string; to: string }
```

### `find_location`

Input:
```ts
{ productionId: string; query: string }
```

### `get_location_availability`

Input:
```ts
{ productionId: string; locationId: string; from: string; to: string }
```

### `get_schedule`

Input:
```ts
{ productionId: string; date?: string; sceneId?: string }
```

### `get_call_sheet`

Input:
```ts
{ productionId: string; shootDayId: string }
```

### `get_tasks`

Input:
```ts
{
  productionId: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}
```

## 5. Analysis tools

### `analyze_change_impact`

Input:
```ts
{
  productionId: string;
  change: TypedChange;
}
```

Output:
```ts
{
  productionVersion: number;
  impacts: Impact[];
  conflicts: Conflict[];
  affectedEntityIds: string[];
}
```

Implementation is deterministic application/domain logic.

### `generate_schedule_candidates`

Input:
```ts
{
  productionId: string;
  sceneIds: string[];
  excludeDates?: string[];
}
```

Output:
```ts
{
  productionVersion: number;
  candidates: { shootDayId: string; date: string; sceneIds: string[]; warnings: string[] }[];
  rejected: { shootDayId: string; date: string; reasons: string[] }[];
}
```

Returns the existing shoot days on which every listed scene could shoot: all
required cast free and the location free, in date order. Days already holding
a moving scene, excluded dates, and days that fail availability come back in
`rejected` with every reason, so "why not Tuesday?" has a data-backed answer.
Warnings on a candidate flag things that do not invalidate it, such as a cast
member already booked that day or a published call sheet.

The generator keeps the group together and only considers existing days. There
is no scoring, capacity model, or splitting; those would be a scheduling solver.

The AI may rank/explain results; it must not fabricate candidates.

### `simulate_proposal`

Input:
```ts
{
  productionId: string;
  baseProductionVersion: number;
  operations: ProposedOperation[];
}
```

Output:
```ts
{
  valid: boolean;
  impacts: Impact[];
  conflicts: Conflict[];
  resolvedConflicts: Conflict[]; // violations present now that the operations make go away
  warnings: string[];
  postStateSummary: SimulationSummary;
}
```

No business mutation. Operations are applied in order to a copy of the
snapshot, and the copy is judged by the same invariants that judge the live
production. Each operation is atomic: it either takes full effect or
contributes a conflict and leaves the copy untouched. An operation whose effect
is already true of the world is skipped and reported as a warning (INV-8).

`valid` means the would-be world satisfies every invariant and every operation
could apply. A proposal that fixes one scene but leaves a second one conflicting
is invalid: an approved plan must be a valid plan, not merely a better one.

If `baseProductionVersion` is not the current version the tool returns
`PRODUCTION_VERSION_MISMATCH` rather than simulating the wrong world.

### `validate_proposal`

Input:
```ts
{ productionId: string; proposalId: string }
```

Returns validity, current version, warnings, and blocking conflicts.

Re-judges the stored proposal against the production as it is now by
re-running the simulation. A production version newer than the proposal's base
adds a `STALE_PRODUCTION_VERSION` conflict. Operations that no longer hash to
the stored digest return `PROPOSAL_INVALID`.

The refreshed verdict is written back onto the proposal so `get_proposal` never
reports a validity the world has since contradicted. That is a change to
proposal metadata, not to production state; no business entity moves.

## 6. Proposal tools

### `create_proposal`

Creates a persisted proposal from already simulated operations.

It is not a business-state mutation, but it must be auditable.

The server re-simulates the operations against the current production, records
the verdict, and computes the digest an approval will bind to. A valid proposal
is persisted as `AWAITING_APPROVAL`; an invalid one is persisted as a `DRAFT`
with its conflicts, so the coordinator can see exactly why it cannot be
approved. A base version that is no longer current returns
`PRODUCTION_VERSION_MISMATCH`.

### `get_proposal`

Returns proposal operations, impacts, validation state, digest, and status.

## 7. Write tools

Prefer a single high-level write capability for the MVP:

### `apply_approved_proposal`

Input:
```ts
{
  productionId: string;
  proposalId: string;
  approvalId: string;
  expectedProductionVersion: number;
  idempotencyKey: string;
}
```

Server behavior:
1. load proposal;
2. load approval;
3. verify approval digest;
4. compare production version;
5. revalidate if required;
6. execute application commands transactionally where possible;
7. increment production version;
8. emit audit events;
9. return affected IDs and verification target.

This is safer than exposing arbitrary `update_schedule`, `update_scene`, etc. directly to the model.

The operation allow-list, as of TASK-108:

- `RECORD_CAST_UNAVAILABILITY` and `RECORD_LOCATION_UNAVAILABILITY` write the
  fact behind an availability change onto the entity itself, so the production
  remembers it after the remedy is applied. The orchestrator includes the
  recording operation in every availability proposal.
- `MOVE_SCENES`
- `ADD_SCENE_REQUIREMENT`
- `CREATE_PREPARATION_TASK`
- `MARK_CALL_SHEET_STALE`

The write applies the proposal's operations through the same function
simulation used, now handed real IDs, so what the coordinator approved is what
happens. A replayed idempotency key answers from its record and touches nothing;
the same key for different work returns `IDEMPOTENCY_CONFLICT`.

The commit and the bookkeeping that follows it (idempotency record, proposal
status, audit) are not one transaction in the file and memory stores. A crash
between them leaves the effects applied and the proposal still `APPROVED`;
`verify_applied_proposal` exists to notice exactly that.

## 8. Verification tool

### `verify_applied_proposal`

Input:
```ts
{
  productionId: string;
  proposalId: string;
}
```

Returns:
```ts
{
  success: boolean;
  checks: {
    name: string;
    passed: boolean;
    detail?: string;
  }[];
}
```

## 9. Error model

Tools return stable codes such as:

```text
ENTITY_NOT_FOUND
ENTITY_AMBIGUOUS
UNSUPPORTED_CHANGE
PRODUCTION_VERSION_MISMATCH
PROPOSAL_INVALID
APPROVAL_REQUIRED
APPROVAL_MISMATCH
CONSTRAINT_VIOLATION
IDEMPOTENCY_CONFLICT
TOOL_UNAUTHORIZED
INVALID_INPUT
INTERNAL_ERROR
```

Schemas for every tool live in `packages/contracts`, registered in
`MCP_TOOL_CONTRACTS`. The server registers tools from that registry and the
contract suite iterates it, so a tool cannot exist without a schema or be tested
against a stale copy of one.

Tool inputs are strict objects: an unknown key is an error rather than something
to ignore, because a tool that silently drops a misspelled field lets an agent
believe it constrained a query that in fact ran unconstrained.

Errors should tell an agent what safe next step is possible.

## 10. MCP contract testing

For every tool test:
- valid input;
- malformed input;
- cross-production ID;
- missing entity;
- deterministic result;
- authorization where relevant.

For `apply_approved_proposal`, additionally test:
- no approval;
- wrong approval;
- stale version;
- replayed idempotency key;
- invalid proposal;
- successful application;
- verification.

## 11. Principle

Give agents **capabilities**, not unrestricted access. A small high-level tool surface is easier to reason about, test, secure, and allow to run autonomously.
