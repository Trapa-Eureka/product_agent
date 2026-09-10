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

Returns candidate shoot days that pass the MVP availability rules.

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
  postStateSummary: unknown;
}
```

No business mutation.

### `validate_proposal`

Input:
```ts
{ productionId: string; proposalId: string }
```

Returns validity, current version, warnings, and blocking conflicts.

## 6. Proposal tools

### `create_proposal`

Creates a persisted proposal from already simulated operations.

It is not a business-state mutation, but it must be auditable.

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

Internal application commands may include:
- `MoveScenes`
- `AddSceneRequirement`
- `CreatePreparationTask`
- `MarkCallSheetStale`

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
PRODUCTION_VERSION_MISMATCH
PROPOSAL_INVALID
APPROVAL_REQUIRED
APPROVAL_MISMATCH
CONSTRAINT_VIOLATION
IDEMPOTENCY_CONFLICT
TOOL_UNAUTHORIZED
INTERNAL_ERROR
```

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
