# Product and Interaction Design

## 1. Design goal

Make a complex production change understandable in under a minute.

The UI should answer four questions in order:

1. **What changed?**
2. **What is affected?**
3. **What do you recommend?**
4. **What will happen if I approve?**

The product should feel like a production operations console with an AI interface, not a generic chatbot.

## 2. Primary layout

Desktop-first MVP:

```text
┌──────────────────────────────────────────────────────────────┐
│ Production: Demo Movie                     Status / Version  │
├───────────────────┬──────────────────────────────────────────┤
│ Production Nav    │ Change Workspace                         │
│                   │                                          │
│ Overview          │ [ user change input ]                    │
│ Scenes            │                                          │
│ Cast              │ Detected Change                          │
│ Locations         │ Impact                                   │
│ Schedule          │ Proposed Plan                            │
│ Call Sheets       │ Warnings                                 │
│ Tasks             │                                          │
│ Audit             │ [Reject] [Approve & Apply]               │
└───────────────────┴──────────────────────────────────────────┘
```

## 3. Change workspace

### Input

Examples appear as helper text:
- Sarah cannot shoot Friday.
- Warehouse is unavailable Friday.
- Scene 18 now needs a red car.

Do not hide ambiguity. If multiple Sarahs or multiple warehouses exist, present a resolution step.

Implementation (TASK-502): the input panel (`ChangeInput`) submits the
sentence as a job (`POST .../changes`) and shows the golden-scenario
sentences as clickable examples. `ChangeSubmissionService` tracks the one job
the panel just submitted; when it lands at `resolving`, `AmbiguityResolution`
renders the run's `message` as the question and its `options` (label plus
the resolved change) as buttons, distinguishing options that share a label
(two cast members both named "Sarah") by the change underneath. Picking one
resumes the same job (`jobId` + the chosen change). `AgentJobEvent` does not
carry `options` — only the `JobRun` record does (TASK-403's contract) — so
the live socket event is read only as a hint to re-fetch the job over REST,
never as the answer itself (ARCHITECTURE.md §11).

### Detected change card

Show:
- normalized change type;
- resolved entity;
- date/scene;
- confidence only if meaningful;
- editable correction before analysis.

Implementation (TASK-502): `DetectedChangeCard` renders the persisted
`ChangeRequest` once the tracked job's `changeRequestId` is known, using
`formatTypedChange` (a pure formatter, unit-tested for all four change
types) for the type label and the resolved fields. Two bullets above are
known gaps rather than omissions: confidence is the model's own score,
computed during interpretation and never written into the persisted
`ChangeRequest`, so there is nothing to read it from; an editable correction
would need a pause after interpretation, but `runChangeAgent` (TASK-305)
runs interpret through propose as one loop with no such pause today.

### Impact panel

Group by domain:

```text
BLOCKING
2 scheduled scenes conflict with Sarah's availability.

AFFECTED
Scenes: 07, 12
Shoot day: Sep 18
Call sheet: CS Sep 18
Tasks: 2

WHY
Scene 07 requires Sarah and is scheduled Sep 18.
Scene 12 requires Sarah and is scheduled Sep 18.
```

The `WHY` explanation should come from deterministic reason codes/data, optionally verbalized by AI.

Implementation: `describeImpact` in `packages/application` builds this panel
from the impact report and the snapshot (a count per blocking reason, affected
entities by kind, the engine's reasons), and `renderImpactExplanation` renders
this text form. Both are pure functions of data.

Implementation (TASK-503): `analyzeChangeImpact` now computes this panel
alongside the raw impacts/conflicts and returns it as `explanation`. The MCP
`analyze_change_impact` tool does not forward it — the strict output schema
gives the agent only the machine-readable `impacts`/`conflicts` it reasons
over — so the REST API exposes it on its own route,
`POST .../analysis/explanation`, one of TASK-110's documented REST-only
exceptions. `ChangeSubmissionService` fetches it once the tracked job's
change request is known, and `ImpactPanel` renders `blocking`, the six
`affected` groups in the same order as `renderImpactExplanation` (empty ones
omitted), and `why` — a presentational component with no logic of its own.

## 4. Proposal comparison

A proposal must show operations before approval.

Example:

```text
Proposal A
Move Scene 07 and Scene 12 from Fri Sep 18 → Mon Sep 21

Effects
+ resolves Sarah conflict
+ Warehouse is available
! John is required Monday
! Call sheet Sep 18 becomes stale
! Monday call sheet must be regenerated

Operations
- remove S07 from SD-0918
- remove S12 from SD-0918
- add S07 to SD-0921
- add S12 to SD-0921
- mark affected call sheets for regeneration
```

Never use a vague button such as `Fix it`.

Implementation (TASK-306): `describeProposal` in `packages/application` builds
this card from the snapshot, the operations, and the simulation findings:

- the headline names the remedy (a move, a requirement) or, failing that, the
  recorded fact;
- `+` effects are resolved conflicts (attributed to the person or place, with
  the scenes), the target day's available location, and recorded facts;
- `!` effects are conflicts that remain, cast required on the target day,
  other engine warnings, skipped operations, call sheets to regenerate,
  requirements to have ready, and new tasks;
- operations are listed one concrete step per line.

The model may add a `narrative` paragraph; it cannot add an effect or an
operation. `renderProposalExplanation` produces the block above, and its
rendered form is the proposal's `summary`, so the UI, the REST API, and an MCP
client all show the same account. The structured shape is the
`proposalExplanationSchema` contract.

Implementation (TASK-504): `runChangeAgent` already builds this structured
card once, synchronously, when it creates the proposal. Rather than
recomputing it later against production state that may have moved on, the
ANALYZE_CHANGE job handler carries it — and, for a scheduling change, the
ranked and rejected shoot days the candidate generator considered — onto the
tracked `JobRun` (`explanation`, `candidateComparison`), the same mechanism
`options` already uses for ambiguity (TASK-502). `ProposalCard` renders the
headline, `+`/`!` effects, and operations with no logic of its own;
`CandidateComparisonPanel` renders the ranked list (the chosen day marked)
and, when something was refused, why. Neither exists for a change that
never generated candidates.

Use:
- `Reject`
- `Approve & Apply`

## 5. Approval

Before a consequential write, show a final confirmation containing:
- proposal summary;
- number of operations;
- warnings;
- current production version;
- explicit note that the production plan will change.

The backend, not the UI, enforces approval validity.

## 6. Job/realtime states

Show a compact progress timeline:

```text
✓ Change received
✓ Entities resolved
✓ Impact analyzed
✓ Proposal simulated
✓ Constraints validated
● Waiting for approval
○ Applying
○ Verifying
```

For failures, show the failed stage and a useful recovery message.

Implementation (TASK-403): the timeline is the `history` of a `JobRun`. A
stage shows `✓` when its `COMPLETED` event exists, `●` when its latest event
is `STARTED`, and the failure line is the `FAILED` event, which is published
against the stage that was running (`applying`, not `failed`) with the
recovery message. A run waiting on the user's answer stays at `resolving`
with the question as its message.

## 7. Audit view

The audit view should make the agent trustworthy.

Example:

```text
11:03 User reported Sarah unavailable Sep 18
11:03 Agent requested impact analysis
11:03 System found 2 conflicting scenes
11:04 Agent proposed P-104
11:05 Jinho approved P-104
11:05 System applied 4 operations
11:05 System verified schedule
```

Do not expose chain-of-thought. Store and display actions, structured reasons, tool results, and user-visible explanations.

The audit actions the agent loop writes, in order: `CHANGE_REQUEST_SUBMITTED`
(user), `ANALYSIS_REQUESTED` (agent), `ANALYSIS_COMPLETED` (system, with the
conflict count), `PROPOSAL_CREATED` (agent); then `PROPOSAL_APPROVED` or
`PROPOSAL_REJECTED` (user), `PROPOSAL_APPLIED` and `PROPOSAL_VERIFIED`
(system). All share the request's correlation ID.

## 8. Accessibility

- keyboard-accessible actions;
- visible focus states;
- no status conveyed by color alone;
- semantic headings and form labels;
- confirmation text understandable without film-industry expertise.

## 9. Visual scope

The MVP should be clean and functional. Do not imitate StudioBinder visual design. Original styling is preferred.

## 10. Demo story

The strongest portfolio demo is a 2–4 minute sequence:

1. Open deterministic Demo Movie.
2. Show Friday schedule.
3. Enter `Sarah cannot shoot Friday`.
4. Watch realtime analysis states.
5. Inspect affected scenes and explanation.
6. Compare proposed reschedule.
7. Approve.
8. Show updated schedule.
9. Show verification and audit event.
10. Repeat quickly with `Scene 18 now needs a red car`.

The demo should emphasize **connected workflow, safe action, and engineering boundaries**, not model spectacle.
