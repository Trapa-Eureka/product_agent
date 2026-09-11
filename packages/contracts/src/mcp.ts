import { z } from "zod";

import { typedChangeSchema } from "./change";
import {
  callSheetSchema,
  castMemberSchema,
  locationSchema,
  requirementSchema,
  sceneSchema,
  shootDaySchema,
  taskRelatedEntityTypeSchema,
  taskSchema,
} from "./entities";
import { conflictSchema, impactSchema } from "./impact";
import {
  entityIdSchema,
  explanationSchema,
  idempotencyKeySchema,
  localDateSchema,
  productionVersionSchema,
  INPUT_LIMITS,
} from "./primitives";
import { proposalSchema, proposedOperationSchema } from "./proposal";

/**
 * MCP tool contracts (MCP.md §4-8).
 *
 * Inputs are strict objects: an unknown key is an error, not something to
 * ignore. A tool that silently drops a misspelled field would let an agent
 * believe it constrained a query that in fact ran unconstrained.
 *
 * Every tool receives `productionId` explicitly so ownership can be checked
 * server-side on every call (INV-4). The agent never selects a database.
 */

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const getProductionInputSchema = z.strictObject({
  productionId: entityIdSchema,
});

export const getProductionOutputSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string().min(1),
  timezone: z.string().min(1),
  version: productionVersionSchema,
});

export const getSceneInputSchema = z
  .strictObject({
    productionId: entityIdSchema,
    sceneId: entityIdSchema.optional(),
    sceneNumber: z.string().min(1).max(32).optional(),
  })
  .refine((input) => input.sceneId !== undefined || input.sceneNumber !== undefined, {
    message: "Provide either sceneId or sceneNumber.",
    path: ["sceneId"],
  });

/** A scene together with the entities it depends on, so callers avoid N+1 reads. */
export const normalizedSceneSchema = z.strictObject({
  scene: sceneSchema,
  location: locationSchema,
  requiredCast: z.array(castMemberSchema),
  requirements: z.array(requirementSchema),
  scheduledShootDayId: entityIdSchema.nullable(),
});

export const getSceneOutputSchema = normalizedSceneSchema;

export const findCastInputSchema = z.strictObject({
  productionId: entityIdSchema,
  query: z.string().min(1).max(200),
});

/**
 * Resolution candidates. Ambiguity is returned rather than guessed away, because
 * picking the wrong "Sarah" silently is worse than asking (DESIGN.md §3).
 */
export const findCastOutputSchema = z.strictObject({
  candidates: z.array(
    z.strictObject({
      id: entityIdSchema,
      name: z.string().min(1),
      roleName: z.string().min(1).optional(),
    }),
  ),
});

export const findLocationInputSchema = findCastInputSchema;

export const findLocationOutputSchema = z.strictObject({
  candidates: z.array(
    z.strictObject({
      id: entityIdSchema,
      name: z.string().min(1),
    }),
  ),
});

const availabilityWindowInputSchema = z.strictObject({
  productionId: entityIdSchema,
  from: localDateSchema,
  to: localDateSchema,
});

export const getCastAvailabilityInputSchema = availabilityWindowInputSchema
  .extend({ castId: entityIdSchema })
  .refine((input) => input.from <= input.to, {
    message: "`from` must be on or before `to`.",
    path: ["to"],
  });

export const getLocationAvailabilityInputSchema = availabilityWindowInputSchema
  .extend({ locationId: entityIdSchema })
  .refine((input) => input.from <= input.to, {
    message: "`from` must be on or before `to`.",
    path: ["to"],
  });

/** Unavailable dates are listed explicitly so a caller never infers absence from a gap. */
export const availabilityOutputSchema = z.strictObject({
  entityId: entityIdSchema,
  from: localDateSchema,
  to: localDateSchema,
  unavailableDates: z.array(localDateSchema),
});

export const getScheduleInputSchema = z.strictObject({
  productionId: entityIdSchema,
  date: localDateSchema.optional(),
  sceneId: entityIdSchema.optional(),
  /** Also return every scene the listed days name, resolved from the same snapshot (TASK-913). */
  includeScenes: z.boolean().optional(),
});

export const getScheduleOutputSchema = z.strictObject({
  productionVersion: productionVersionSchema,
  shootDays: z.array(shootDaySchema),
  /**
   * Present only when `includeScenes` was asked for: each distinct scene the
   * returned days schedule, in day order, normalized like `get_scene`. One
   * read of the production instead of one per scene.
   */
  scenes: z.array(normalizedSceneSchema).optional(),
});

export const getCallSheetInputSchema = z.strictObject({
  productionId: entityIdSchema,
  shootDayId: entityIdSchema,
});

export const getCallSheetOutputSchema = z.strictObject({
  callSheet: callSheetSchema.nullable(),
});

export const getTasksInputSchema = z.strictObject({
  productionId: entityIdSchema,
  relatedEntityType: taskRelatedEntityTypeSchema.optional(),
  relatedEntityId: entityIdSchema.optional(),
});

export const getTasksOutputSchema = z.strictObject({
  tasks: z.array(taskSchema),
});

// ---------------------------------------------------------------------------
// Analysis tools
// ---------------------------------------------------------------------------

export const analyzeChangeImpactInputSchema = z.strictObject({
  productionId: entityIdSchema,
  change: typedChangeSchema,
});

export const analyzeChangeImpactOutputSchema = z.strictObject({
  productionVersion: productionVersionSchema,
  impacts: z.array(impactSchema),
  conflicts: z.array(conflictSchema),
  affectedEntityIds: z.array(entityIdSchema),
});

export const generateScheduleCandidatesInputSchema = z.strictObject({
  productionId: entityIdSchema,
  sceneIds: z.array(entityIdSchema).min(1).max(INPUT_LIMITS.sceneIdsPerOperation),
  excludeDates: z.array(localDateSchema).max(INPUT_LIMITS.excludeDates).optional(),
});

/** An existing shoot day on which every moving scene's cast and location are free. */
export const scheduleCandidateSchema = z.strictObject({
  shootDayId: entityIdSchema,
  date: localDateSchema,
  sceneIds: z.array(entityIdSchema).min(1),
  /** Things worth knowing that do not invalidate the day, e.g. a cast member already booked. */
  warnings: z.array(explanationSchema),
});

/** A shoot day that was considered and refused, with every reason it failed. */
export const rejectedScheduleDaySchema = z.strictObject({
  shootDayId: entityIdSchema,
  date: localDateSchema,
  reasons: z.array(explanationSchema).min(1),
});

/**
 * Candidates come from the deterministic engine. A model may reorder or explain
 * them; it must not add one (MCP.md §5). Rejected days are returned too, so
 * "why not Tuesday?" has a data-backed answer.
 */
export const generateScheduleCandidatesOutputSchema = z.strictObject({
  productionVersion: productionVersionSchema,
  candidates: z.array(scheduleCandidateSchema),
  rejected: z.array(rejectedScheduleDaySchema),
});

/** What the production would look like afterwards, without writing anything. */
export const simulationSummarySchema = z.strictObject({
  shootDays: z.array(
    z.strictObject({
      id: entityIdSchema,
      date: localDateSchema,
      sceneIds: z.array(entityIdSchema),
    }),
  ),
  addedRequirementNames: z.array(z.string().min(1)),
  addedTaskTitles: z.array(z.string().min(1)),
  staleCallSheetIds: z.array(entityIdSchema),
});

export const simulateProposalInputSchema = z.strictObject({
  productionId: entityIdSchema,
  baseProductionVersion: productionVersionSchema,
  operations: z.array(proposedOperationSchema).min(1).max(INPUT_LIMITS.operationsPerProposal),
});

export const simulateProposalOutputSchema = z.strictObject({
  valid: z.boolean(),
  impacts: z.array(impactSchema),
  conflicts: z.array(conflictSchema),
  /** Violations present before the operations that are gone afterwards ("resolves Sarah conflict"). */
  resolvedConflicts: z.array(conflictSchema),
  warnings: z.array(explanationSchema),
  postStateSummary: simulationSummarySchema,
});

export const validateProposalInputSchema = z.strictObject({
  productionId: entityIdSchema,
  proposalId: entityIdSchema,
});

export const validateProposalOutputSchema = z.strictObject({
  valid: z.boolean(),
  productionVersion: productionVersionSchema,
  baseProductionVersion: productionVersionSchema,
  warnings: z.array(explanationSchema),
  conflicts: z.array(conflictSchema),
});

// ---------------------------------------------------------------------------
// Proposal tools
// ---------------------------------------------------------------------------

export const createProposalInputSchema = z.strictObject({
  productionId: entityIdSchema,
  changeRequestId: entityIdSchema,
  baseProductionVersion: productionVersionSchema,
  operations: z.array(proposedOperationSchema).min(1).max(INPUT_LIMITS.operationsPerProposal),
  summary: explanationSchema,
});

export const createProposalOutputSchema = z.strictObject({
  proposal: proposalSchema,
});

export const getProposalInputSchema = validateProposalInputSchema;

export const getProposalOutputSchema = createProposalOutputSchema;

// ---------------------------------------------------------------------------
// Write tool
// ---------------------------------------------------------------------------

/**
 * The only consequential write exposed to an agent. It names the approval and
 * the version it expects, so the server can refuse a stale or unapproved apply
 * instead of trusting the caller (MCP.md §7, INV-5/INV-6).
 */
export const applyApprovedProposalInputSchema = z.strictObject({
  productionId: entityIdSchema,
  proposalId: entityIdSchema,
  approvalId: entityIdSchema,
  expectedProductionVersion: productionVersionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const applyApprovedProposalOutputSchema = z.strictObject({
  applied: z.boolean(),
  /** True when a replay was recognised and no second mutation happened (INV-8). */
  replayed: z.boolean(),
  productionVersion: productionVersionSchema,
  affectedEntityIds: z.array(entityIdSchema),
  proposalStatus: proposalSchema.shape.status,
});

// ---------------------------------------------------------------------------
// Verification tool
// ---------------------------------------------------------------------------

export const verifyAppliedProposalInputSchema = validateProposalInputSchema;

/**
 * A check name is a one-line label. The verifier (`@pca/domain`) clips what it
 * builds to this length, so a valid proposal can never produce output this
 * schema refuses (TASK-912).
 */
export const VERIFICATION_CHECK_NAME_MAX_LENGTH = 120;

export const verifyAppliedProposalOutputSchema = z.strictObject({
  success: z.boolean(),
  checks: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(VERIFICATION_CHECK_NAME_MAX_LENGTH),
        passed: z.boolean(),
        detail: explanationSchema.optional(),
      }),
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Single registry of the tool surface. The MCP server registers from it and the
 * contract suite iterates it, so a tool cannot be added without a schema or
 * tested by accident against a stale copy of one.
 */
export const MCP_TOOL_CONTRACTS = {
  get_production: { input: getProductionInputSchema, output: getProductionOutputSchema },
  get_scene: { input: getSceneInputSchema, output: getSceneOutputSchema },
  find_cast: { input: findCastInputSchema, output: findCastOutputSchema },
  get_cast_availability: {
    input: getCastAvailabilityInputSchema,
    output: availabilityOutputSchema,
  },
  find_location: { input: findLocationInputSchema, output: findLocationOutputSchema },
  get_location_availability: {
    input: getLocationAvailabilityInputSchema,
    output: availabilityOutputSchema,
  },
  get_schedule: { input: getScheduleInputSchema, output: getScheduleOutputSchema },
  get_call_sheet: { input: getCallSheetInputSchema, output: getCallSheetOutputSchema },
  get_tasks: { input: getTasksInputSchema, output: getTasksOutputSchema },
  analyze_change_impact: {
    input: analyzeChangeImpactInputSchema,
    output: analyzeChangeImpactOutputSchema,
  },
  generate_schedule_candidates: {
    input: generateScheduleCandidatesInputSchema,
    output: generateScheduleCandidatesOutputSchema,
  },
  simulate_proposal: { input: simulateProposalInputSchema, output: simulateProposalOutputSchema },
  validate_proposal: { input: validateProposalInputSchema, output: validateProposalOutputSchema },
  create_proposal: { input: createProposalInputSchema, output: createProposalOutputSchema },
  get_proposal: { input: getProposalInputSchema, output: getProposalOutputSchema },
  apply_approved_proposal: {
    input: applyApprovedProposalInputSchema,
    output: applyApprovedProposalOutputSchema,
  },
  verify_applied_proposal: {
    input: verifyAppliedProposalInputSchema,
    output: verifyAppliedProposalOutputSchema,
  },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type McpToolName = keyof typeof MCP_TOOL_CONTRACTS;

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOL_CONTRACTS) as [McpToolName, ...McpToolName[]];

export const mcpToolNameSchema = z.enum(MCP_TOOL_NAMES);

/** Tools that may mutate production state. Everything else must be side-effect free. */
export const MCP_WRITE_TOOL_NAMES = [
  "apply_approved_proposal",
] as const satisfies readonly McpToolName[];

export type McpWriteToolName = (typeof MCP_WRITE_TOOL_NAMES)[number];

export type McpToolInput<TName extends McpToolName> = z.infer<
  (typeof MCP_TOOL_CONTRACTS)[TName]["input"]
>;

export type McpToolOutput<TName extends McpToolName> = z.infer<
  (typeof MCP_TOOL_CONTRACTS)[TName]["output"]
>;

export type NormalizedScene = z.infer<typeof normalizedSceneSchema>;
export type ScheduleCandidate = z.infer<typeof scheduleCandidateSchema>;
export type RejectedScheduleDay = z.infer<typeof rejectedScheduleDaySchema>;
export type SimulationSummary = z.infer<typeof simulationSummarySchema>;
