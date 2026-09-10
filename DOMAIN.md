# Domain Model

## 1. Design principle

The domain model is the source of truth for production relationships. AI does not invent these relationships.

The MVP models enough production structure to demonstrate change propagation without attempting to reproduce a complete industry product.

## 2. Core entities

### Production

```ts
type Production = {
  id: string;
  name: string;
  timezone: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

`version` supports optimistic concurrency and stale-proposal detection.

### Scene

```ts
type Scene = {
  id: string;
  productionId: string;
  sceneNumber: string;
  title?: string;
  description?: string;
  locationId: string;
  requiredCastIds: string[];
  requirementIds: string[];
  estimatedMinutes: number;
};
```

### CastMember

```ts
type CastMember = {
  id: string;
  productionId: string;
  name: string;
  roleName?: string;
  unavailable: DateRange[];
};
```

### Location

```ts
type Location = {
  id: string;
  productionId: string;
  name: string;
  unavailable: DateRange[];
};
```

### Requirement

```ts
type RequirementType =
  | "PROP"
  | "WARDROBE"
  | "EQUIPMENT"
  | "VEHICLE"
  | "VFX"
  | "OTHER";

type Requirement = {
  id: string;
  productionId: string;
  sceneId: string;
  type: RequirementType;
  name: string;
  status: "NEEDED" | "READY" | "UNAVAILABLE";
};
```

For the MVP, `red car` may be represented as `PROP` or `VEHICLE`; choose one canonical type in implementation and test it consistently.

### ShootDay

```ts
type ShootDay = {
  id: string;
  productionId: string;
  date: string; // local production YYYY-MM-DD
  sceneIds: string[];
  status: "DRAFT" | "CONFIRMED";
};
```

### CallSheet

```ts
type CallSheet = {
  id: string;
  productionId: string;
  shootDayId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
};
```

The MVP does not need full call-sheet content. It needs enough linkage to show downstream impact.

### Task

```ts
type Task = {
  id: string;
  productionId: string;
  title: string;
  relatedEntityType: "SCENE" | "SHOOT_DAY" | "CALL_SHEET" | "REQUIREMENT";
  relatedEntityId: string;
  status: "OPEN" | "DONE";
};
```

### ChangeRequest

```ts
type ChangeType =
  | "CAST_UNAVAILABLE"
  | "LOCATION_UNAVAILABLE"
  | "SCENE_REQUIREMENT_CHANGED"
  | "SCHEDULE_CHANGED";

type ChangeRequest = {
  id: string;
  productionId: string;
  type: ChangeType;
  rawText: string;
  payload: TypedChange;
  correlationId: string;
  createdBy: string;
  createdAt: string;
};
```

`payload` is the resolved `TypedChange`, not an untyped value, and `type` must
agree with `payload.type`. A typed change carries resolved IDs only, never a
name such as `Sarah` or a phrase such as `Friday`; entity resolution happens
before intake so the deterministic layer can verify every reference.

`correlationId` ties the request to its agent job, MCP calls, and proposal in
logs (ARCHITECTURE.md §16).

### Impact

```ts
type Impact = {
  entityType: EntityType;
  entityId: string;
  reasonCode: string;
  explanation: string;
  severity: "INFO" | "WARNING" | "BLOCKING";
};
```

### Proposal

```ts
type Proposal = {
  id: string;
  productionId: string;
  changeRequestId: string;
  baseProductionVersion: number;
  operations: ProposedOperation[];
  impacts: Impact[];
  conflicts: Conflict[];
  warnings: string[];
  validationStatus: "VALID" | "INVALID";
  status: "DRAFT" | "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED" | "FAILED";
  digest: string;
  summary: string;
  createdAt: string;
};
```

`digest` hashes the operations together with `baseProductionVersion`. An
approval binds to it, so editing a proposal after approval invalidates that
approval rather than silently widening it (INV-6).

### Approval

```ts
type Approval = {
  id: string;
  productionId: string;
  proposalId: string;
  proposalDigest: string;
  productionVersion: number;
  approvedBy: string;
  decision: "APPROVE" | "REJECT";
  createdAt: string;
};
```

`productionId` is present so every repository read can be scoped by production
(INV-4). Deriving tenancy by first loading the proposal would make the isolation
boundary depend on a join a caller can forget.

### AuditEvent

```ts
type AuditEvent = {
  id: string;
  productionId: string;
  actorType: "USER" | "AGENT" | "SYSTEM";
  actorId?: string;
  action: string;
  entityType?: AuditSubjectType; // any EntityType, or CHANGE_REQUEST | PROPOSAL | APPROVAL | JOB
  entityId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};
```

## 3. Relationships

```text
Production
 ├─ Scene
 │   ├─ CastMember*
 │   ├─ Location
 │   └─ Requirement*
 ├─ ShootDay
 │   └─ Scene*
 ├─ CallSheet → ShootDay
 ├─ Task → related entity
 ├─ ChangeRequest
 ├─ Proposal
 ├─ Approval
 └─ AuditEvent
```

## 4. Domain invariants

### INV-1 Cast availability
A scene cannot be considered validly scheduled on a day when any required cast member is unavailable.

### INV-2 Location availability
A scene cannot be considered validly scheduled on a day when its required location is unavailable.

### INV-3 Scene integrity
A scheduled scene must reference valid production-owned cast/location/requirements.

A scene may also appear on at most one shoot day. A scene scheduled twice is a
scheduling corruption rather than a plan, so it is reported here with
`SCENE_ALREADY_ON_SHOOT_DAY`.

### INV-4 Production isolation
Entities from one production cannot be referenced by another production.

### INV-5 Approval before write
No consequential proposal operation may be applied without a valid approval.

### INV-6 Approval freshness
Approval is valid only for the exact proposal digest and expected production version.

Approving is strict: the proposal must be valid, un-tampered, and fresh, and it
is re-simulated once more against the current production before the record is
written. Rejecting is lenient: a coordinator may always say no, including to a
stale proposal.

A decision is final. Repeating the same decision returns the existing record;
contradicting it is refused. A rejected proposal is not revived; a new one is
made.

### INV-7 Post-write versioning
A successful consequential mutation increments the production version.

### INV-8 Idempotency
Replaying the same operation/idempotency key must not create duplicate tasks or duplicate schedule changes.

Two complementary checks enforce this. A key-based check classifies a repeated
idempotency key as a first run, a replay of identical work, or a conflict with
different work. A state-based check asks whether the world already matches what
an operation would produce, which catches a repeat that arrives without the
original key.

## 5. Change propagation

### CAST_UNAVAILABLE

```text
Cast availability
   ↓
Scenes requiring cast
   ↓
Shoot days containing those scenes
   ↓
Call sheets for those days
   ↓
Related tasks / proposed reschedule
```

### LOCATION_UNAVAILABLE

```text
Location availability
   ↓
Scenes at location
   ↓
Shoot days
   ↓
Required cast on those scenes
   ↓
Call sheets / tasks / reschedule candidates
```

### SCENE_REQUIREMENT_CHANGED

```text
Scene
   ↓
Requirement
   ↓
Shoot day
   ↓
Preparation task
   ↓
Call-sheet impact
```

### Reach

Only entities the change actually reaches are reported. A scene that needs a
cast member but shoots on a day outside their unavailability window is
untouched and does not appear. Done tasks are skipped; open ones may now point
at a stale plan. The subject of a change (the cast member who became
unavailable, the location that closed) is the cause and is not listed as an
effect. The golden scenarios assert exact sets: an over-eager list teaches a
coordinator to skim, and a short one ships a broken day.

### Reason codes

Every impact carries one of a closed set of reason codes. The "WHY" a
coordinator reads is derived from the code and the data behind it, so an
explanation can never claim something the engine did not find.

| Code | Severity | Meaning |
|---|---|---|
| `SCENE_REQUIRES_UNAVAILABLE_CAST` | BLOCKING | A scheduled scene needs a cast member who is unavailable that day. |
| `SCENE_AT_UNAVAILABLE_LOCATION` | BLOCKING | A scheduled scene shoots at a location that is unavailable that day. |
| `CAST_REQUIRED_ON_TARGET_DAY` | WARNING or BLOCKING | A move needs this cast member on the target day; blocking if they are unavailable. |
| `LOCATION_REQUIRED_ON_TARGET_DAY` | WARNING or BLOCKING | A move needs this location on the target day; blocking if unavailable. |
| `SHOOT_DAY_CONTAINS_AFFECTED_SCENE` | WARNING | The day holds, loses, or gains an affected scene. |
| `CALL_SHEET_DERIVED_FROM_AFFECTED_SHOOT_DAY` | WARNING | The call sheet describes a day that is changing and must be regenerated. |
| `CAST_ATTACHED_TO_AFFECTED_SCENE` | INFO | Another cast member on an affected scene, whose schedule a move touches. |
| `LOCATION_ATTACHED_TO_AFFECTED_SCENE` | INFO | The location of an affected scene, which a move must keep available. |
| `TASK_LINKED_TO_AFFECTED_ENTITY` | INFO | An open task attached to an affected scene, day, call sheet, or requirement. |
| `SCENE_REQUIREMENT_ADDED` | INFO | The scene gains a requirement it did not have. |
| `SCENE_REQUIREMENT_ALREADY_PRESENT` | INFO | An equivalent requirement already exists; nothing to add. |
| `SCENE_RESCHEDULED` | INFO | The scene moves to another day. |

Impacts are returned in a canonical order: severity, then entity kind, then
ID. Traversal order is an implementation detail; the order a coordinator reads
is not, and a stable order is what lets a golden test assert the exact array.

## 6. Deterministic vs AI-owned behavior

### Deterministic
- entity existence;
- relationship traversal;
- availability checks;
- schedule validity;
- impact graph;
- proposal state;
- approval validation;
- writes;
- verification.

### AI-assisted
- interpreting `Sarah cannot shoot Friday`;
- mapping `red car` to a requirement candidate;
- explaining impacts;
- presenting/ranking valid alternatives.

If AI output conflicts with deterministic domain state, deterministic state wins.

## 7. Invariant implementation

`packages/domain` implements every invariant as a pure function over an
immutable production snapshot.

- INV-1 to INV-4 are state invariants. Each returns every violation it finds as
  a `Conflict`, so a caller sees the full picture rather than the first problem
  encountered.
- INV-5 to INV-8 are guards on the approval and apply path. Each returns a
  stable error code with expected and actual values and the next safe action,
  because their audience is a caller deciding what to do next.

Requirement identity is a domain rule, not a prompt: `Red Car`, `red  car`, and
`red car` are the same requirement of the same type.

The proposal digest covers the production, the change request, the base version,
and the ordered operations. It deliberately excludes impacts, warnings, and
prose, so re-wording an explanation does not invalidate a valid approval while
changing a single operation does.
