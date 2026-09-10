import type { McpToolName } from "@pca/contracts";

/**
 * What each tool is for, in the agent's reading. Kept beside the registry so
 * a tool cannot be advertised without a description, and short so the model
 * spends its attention on the schema rather than prose.
 */
export const TOOL_DESCRIPTIONS: Readonly<Record<McpToolName, string>> = {
  get_production: "Read a production's name, timezone, and current version.",
  get_scene: "Read one scene with its location, required cast, requirements, and shoot day.",
  find_cast: "Resolve a cast member by name. Returns candidates; ambiguity is yours to resolve.",
  get_cast_availability: "List the dates a cast member is unavailable within a window.",
  find_location: "Resolve a location by name. Returns candidates; ambiguity is yours to resolve.",
  get_location_availability: "List the dates a location is unavailable within a window.",
  get_schedule: "Read shoot days, optionally for one date or the day holding one scene.",
  get_call_sheet: "Read the call sheet for a shoot day, if one exists.",
  get_tasks: "List tasks, optionally those linked to one entity.",
  analyze_change_impact:
    "Deterministically list every entity a typed change affects, with a reason for each.",
  generate_schedule_candidates:
    "List existing shoot days on which the given scenes could shoot, with warnings and refusals.",
  simulate_proposal: "Apply operations to a copy of the production and report the would-be world.",
  validate_proposal: "Re-judge a stored proposal against the production as it is now.",
  create_proposal: "Seal simulated operations into a persisted proposal awaiting approval.",
  get_proposal: "Read a proposal with its operations, impacts, validity, digest, and status.",
  apply_approved_proposal:
    "Apply a proposal that a human has approved. Requires the approval ID, expected version, and an idempotency key.",
  verify_applied_proposal:
    "Re-read the production and check every postcondition of an applied proposal.",
};
