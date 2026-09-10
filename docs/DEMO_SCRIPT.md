# Demo script

A 2–4 minute walkthrough for a portfolio recording or a live interview,
expanding DESIGN.md §10's ten-step story into exact actions and talking
points. Everything below matches what the app actually does — this script is
driven from the same golden scenarios the E2E suite (`e2e/golden-*.spec.ts`)
asserts, not a scripted-looking cut.

## Setup (before recording)

```bash
pnpm install
pnpm run seed                              # resets Demo Movie into the file store
PCA_STORAGE=file PCA_API_PORT=3000 pnpm exec tsx apps/api/src/main.ts &
pnpm --filter @pca/web start                # http://localhost:4200
```

`pnpm run seed` matters even for a re-recording: it clears any proposals or
audit trail a previous take left behind, so the Audit view starts empty.

## Part 1 — Cast unavailable (≈2 minutes)

The core scenario. Follows DESIGN.md §1's four questions in order.

| Time | Action | Say |
|---|---|---|
| 0:00 | Open `http://localhost:4200`, Demo Movie workspace (§2 layout) | "This is a production change agent — it understands how a change to cast, locations, or scenes ripples through the rest of a shoot, and it never writes anything without a human approving it first." |
| 0:10 | Click the example **"Sarah cannot shoot Friday."** (§3 input) | "I'm not typing a command — this is a plain-language report of a problem." |
| 0:20 | Detected Change card appears | "The agent normalized this into a typed change: cast member Sarah, unavailable Friday, September 18th." |
| 0:30 | Impact panel appears (§3), point at BLOCKING/AFFECTED/WHY | "**What is affected?** Two scenes — 07 and 12 — are scheduled Friday and both need Sarah. That's deterministic dependency analysis, not a model guessing — the WHY text comes straight from the reason the engine found, the same explanation an MCP client gets." |
| 0:50 | Proposal card appears (§4) | "**What do you recommend?** It found another day where Sarah and the Warehouse are both free — Monday or Tuesday, whichever leaves fewer new conflicts — and proposes moving both scenes there. Below, the operations are spelled out one line at a time: nothing here is a vague 'fix it' button." |
| 1:05 | Point at the ranked-candidates panel if visible | "It also shows the days it considered and rejected, and why — so the recommendation isn't a black box." |
| 1:15 | Click **Approve & Apply**, confirmation dialog appears (§5) | "**What happens if I approve?** Before anything is written, it shows the exact plan, how many operations, remaining warnings, and the production version it's about to change — the backend checks that version too, so this can't silently clobber someone else's edit." |
| 1:25 | Confirm | |
| 1:30 | Progress timeline runs live over WebSocket (§6) | "Every stage is real-time: analyzed, simulated, validated, applying, verifying — this isn't a spinner, it's the actual job." |
| 1:45 | Open **Schedule** nav (§2) | "Scene 07 and 12 are off Friday now, on the day it proposed." |
| 1:55 | Open **Audit** nav (§7) | "And here's the full story in order — who reported it, when the agent asked for analysis, what it found, what was proposed, who approved it, what was applied, and that it verified afterward. No chain-of-thought, no hidden reasoning — just actions, structured reasons, and results." |

## Part 2 — Scene requirement, quick replay (≈45 seconds)

DESIGN.md §10 step 10: repeat quickly with a change that has no scheduling
move at all, to show the range of what "a change" means here.

| Time | Action | Say |
|---|---|---|
| 2:15 | New workspace, click example **"Scene 18 now needs a red car."** | "Not every change is a scheduling conflict." |
| 2:25 | Proposal card | "This one doesn't move anything — it adds the requirement to the scene and creates a prep task to source the car. Same pipeline, different outcome, because the engine reasons about what actually changed." |
| 2:35 | Approve & Apply → Audit | "Applied and verified, same as before." |

## Closing (≈15 seconds)

"The AI's job here is narrow on purpose: interpret the sentence, rank the
options the engine already validated, and put the findings into prose.
Everything that has to be right — the dependency graph, the constraint
checks, the approval gate, the audit trail — is deterministic code, and none
of it required a paid account to run: this is a JSON file store, a
rule-based interpreter, and an in-process queue. The Bedrock/MongoDB/SQS
adapters exist and are tested, but the default demo you just watched didn't
touch AWS."

## If asked (not part of the timed cut)

- **"Why not let the model just write to the database?"** — MCP.md's write
  tools call the same application services the REST API calls; they read,
  analyze, simulate, and propose, but a write needs an approval record bound
  to that exact proposal (CLAUDE.md rules 5–9, ARCHITECTURE.md §4).
- **"What if the model hallucinates an entity?"** — `guardModelPort`
  (ARCHITECTURE.md §7) refuses an interpretation that names an ID outside
  the context it was given, before it ever reaches intake.
- **"What does 'free-first' mean here?"** — every adapter has a free default
  (file store, rule-based model, in-process queue); Mongo/Bedrock/SQS/
  Terraform are implemented and documented but never required
  (ARCHITECTURE.md §2, README "Free-first defaults").
- **"How is this tested?"** — GOLDEN-1/2/3 (TESTING.md §4) are asserted at
  the domain, application, MCP-contract, REST, and now real-browser E2E
  level (`e2e/golden-*.spec.ts`) — the same three scenarios this script
  drives, all the way down.

## Recording notes

- The target day for the cast/location scenarios (Monday vs. Tuesday) is
  whichever the rule-based ranker scores fewest new warnings — say "Monday
  or Tuesday" rather than committing to one, so a re-recording never
  contradicts the narration (see `e2e/golden-1-sarah-unavailable.spec.ts`).
- Total run time end to end is ≈3 minutes; trim Part 2 first if a shorter
  cut is needed — Part 1 alone already answers all four of DESIGN.md §1's
  questions.
