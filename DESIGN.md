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

### Detected change card

Show:
- normalized change type;
- resolved entity;
- date/scene;
- confidence only if meaningful;
- editable correction before analysis.

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
