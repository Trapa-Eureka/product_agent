import type {
  ExplainImpactInput,
  ExplanationOutput,
  InterpretChangeInput,
  InterpretedChange,
  RankCandidatesInput,
  RankedCandidatesOutput,
  TypedChange,
} from "@pca/contracts";
import {
  explanationOutputSchema,
  interpretedChangeSchema,
  rankedCandidatesOutputSchema,
} from "@pca/contracts";

import type { Logger } from "./logging";

/**
 * The model port (ARCHITECTURE.md §7, SPEC.md §6).
 *
 * A model may interpret a sentence, explain deterministic findings, and rank
 * candidates the engine already validated. It may not invent an entity ID,
 * fabricate a candidate day, decide authorisation, or bypass approval. The
 * interface says what a model is asked; `guardModelPort` enforces what it may
 * answer, so the guarantee holds for the rule-based adapter, a local Ollama,
 * and Bedrock alike.
 */
export interface ModelPort {
  interpretChange(input: InterpretChangeInput): Promise<InterpretedChange>;
  explainImpact(input: ExplainImpactInput): Promise<ExplanationOutput>;
  rankCandidates(input: RankCandidatesInput): Promise<RankedCandidatesOutput>;
}

export type ModelErrorCode =
  "MALFORMED_OUTPUT" | "UNGROUNDED_OUTPUT" | "PROVIDER_ERROR" | "TIMEOUT";

/** Thrown by the guard; the orchestrator maps it to a ToolError. Never carries prompt text. */
export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    readonly operation: keyof ModelPort,
    message: string,
    readonly detail?: string,
  ) {
    super(`${code}: ${operation}: ${message}`);
    this.name = "ModelError";
  }
}

/** Every ID a typed change names, so grounding can check each against the context. */
const idsNamedBy = (change: TypedChange): string[] => {
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return [change.castId];
    case "LOCATION_UNAVAILABLE":
      return [change.locationId];
    case "SCENE_REQUIREMENT_CHANGED":
      return [change.sceneId];
    case "SCHEDULE_CHANGED":
      return [...change.sceneIds, change.toShootDayId];
  }
};

const knownIds = (input: InterpretChangeInput): Set<string> =>
  new Set([
    ...input.context.castMembers.map((cast) => cast.id),
    ...input.context.locations.map((location) => location.id),
    ...input.context.scenes.map((scene) => scene.id),
    ...input.context.shootDays.map((day) => day.id),
  ]);

/** Rejects any ID the model was not shown. A confident answer about a made-up entity is the failure this exists for. */
const assertGroundedInterpretation = (
  input: InterpretChangeInput,
  output: InterpretedChange,
): void => {
  const known = knownIds(input);
  const changes =
    output.kind === "RESOLVED"
      ? [output.change]
      : output.kind === "AMBIGUOUS"
        ? output.options.map((option) => option.change)
        : [];
  for (const change of changes) {
    const unknown = idsNamedBy(change).find((id) => !known.has(id));
    if (unknown !== undefined) {
      throw new ModelError(
        "UNGROUNDED_OUTPUT",
        "interpretChange",
        `The model named ${unknown}, which was not in the context it was given.`,
        unknown,
      );
    }
  }
};

/**
 * Model prose is untrusted presentation data (TASK-920, SEC-009 / AUD-014).
 *
 * A narrative or a ranking reason cannot add an operation — the contracts
 * see to that — but it reaches the human at the approval boundary, where a
 * persuasive false claim has the most leverage. Two closed checks keep it
 * honest. It may not assert authorization or safety at all: those are the
 * engine's and the approver's to say, never the model's. And it may not
 * contradict the findings it was handed, or name an entity it was not
 * shown. A rejected text is `UNGROUNDED_OUTPUT`; the orchestrator then
 * shows the deterministic card without prose rather than with a lie.
 */

/** Claims a model may never make, whatever the findings. */
const FORBIDDEN_CLAIMS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\b(?:already|pre-?)\s*(?:approved|authori[sz]ed)\b/iu, label: "prior approval" },
  { pattern: /\b(?:approved|authori[sz]ed)\s+by\b/iu, label: "approval by someone" },
  {
    pattern: /\bno approval\s+(?:is\s+)?(?:needed|required|necessary)\b/iu,
    label: "no approval needed",
  },
  {
    pattern:
      /\b(?:does\s+not|doesn't|won't|will\s+not|need\s+not)\s+(?:need|require)\s+(?:an\s+)?approval\b/iu,
    label: "no approval needed",
  },
  { pattern: /\bwithout\s+(?:an\s+)?approval\b/iu, label: "approval bypass" },
  { pattern: /\bskip(?:s|ped|ping)?\s+(?:the\s+)?approval\b/iu, label: "approval bypass" },
  { pattern: /\bsafe\s+to\s+apply\b/iu, label: "safety" },
  { pattern: /\b(?:no|zero)\s+risk\b|\brisk-free\b/iu, label: "safety" },
];

/** Claims that are false against the findings the model was given. */
const contradictedClaim = (
  text: string,
  facts: { readonly conflicts: number; readonly impacts: number; readonly warnings: number },
): string | null => {
  if (facts.conflicts > 0 && /\b(?:no|zero)\s+conflicts?\b|\bconflict-free\b/iu.test(text)) {
    return "no conflicts";
  }
  if (
    facts.impacts > 0 &&
    /\b(?:no|zero)\s+impacts?\b|\bnothing\s+(?:is\s+|will\s+be\s+)?affected\b/iu.test(text)
  ) {
    return "no impact";
  }
  if (facts.warnings > 0 && /\b(?:no|zero)\s+warnings?\b/iu.test(text)) {
    return "no warnings";
  }
  return null;
};

/** Tokens shaped like entity IDs (`CAST-SARAH`, `SD-2026-09-18`); a bare `S07` is not checked. */
const ID_LIKE = /\b[A-Z]{1,8}-[A-Za-z0-9][A-Za-z0-9._:-]*/gu;

const idTokensIn = (text: string): string[] =>
  [...text.matchAll(ID_LIKE)].map((match) => match[0].replace(/[.:,;]+$/u, ""));

const unknownIdReference = (text: string, known: ReadonlySet<string>): string | null =>
  idTokensIn(text).find((token) => !known.has(token)) ?? null;

const assertHonestProse = (
  operation: keyof ModelPort,
  text: string,
  facts: { readonly conflicts: number; readonly impacts: number; readonly warnings: number },
  known: ReadonlySet<string>,
): void => {
  const forbidden = FORBIDDEN_CLAIMS.find((claim) => claim.pattern.test(text));
  if (forbidden !== undefined) {
    throw new ModelError(
      "UNGROUNDED_OUTPUT",
      operation,
      `The model asserted ${forbidden.label}, which only the engine and the approver may say.`,
      forbidden.label,
    );
  }
  const contradicted = contradictedClaim(text, facts);
  if (contradicted !== null) {
    throw new ModelError(
      "UNGROUNDED_OUTPUT",
      operation,
      `The model claimed "${contradicted}" against findings that say otherwise.`,
      contradicted,
    );
  }
  const unknown = unknownIdReference(text, known);
  if (unknown !== null) {
    throw new ModelError(
      "UNGROUNDED_OUTPUT",
      operation,
      `The model named ${unknown}, which was not in the findings it was given.`,
      unknown,
    );
  }
};

const assertGroundedNarrative = (input: ExplainImpactInput, output: ExplanationOutput): void => {
  const blocking = input.impacts.filter((impact) => impact.severity === "BLOCKING").length;
  const warningImpacts = input.impacts.filter((impact) => impact.severity === "WARNING").length;
  // Whatever the model was shown it may echo: the entities named, and any
  // ID inside the findings' own text.
  const known = new Set<string>([
    input.productionId,
    ...idsNamedBy(input.change),
    ...input.impacts.map((impact) => impact.entityId),
    ...input.conflicts.map((conflict) => conflict.entityId),
    ...(input.resolvedConflicts ?? []).map((conflict) => conflict.entityId),
    ...[
      input.rawText,
      ...input.impacts.map((impact) => impact.explanation),
      ...input.conflicts.map((conflict) => conflict.detail),
      ...(input.resolvedConflicts ?? []).map((conflict) => conflict.detail),
      ...(input.warnings ?? []),
    ].flatMap(idTokensIn),
  ]);
  assertHonestProse(
    "explainImpact",
    output.explanation,
    {
      conflicts: input.conflicts.length + blocking,
      impacts: input.impacts.length,
      warnings: warningImpacts + (input.warnings?.length ?? 0),
    },
    known,
  );
};

const assertGroundedReasons = (
  input: RankCandidatesInput,
  output: RankedCandidatesOutput,
): void => {
  const known = new Set<string>([
    input.productionId,
    ...idsNamedBy(input.change),
    ...input.candidates.flatMap((candidate) => [candidate.shootDayId, ...candidate.sceneIds]),
    ...(input.rejected ?? []).map((day) => day.shootDayId),
    ...[
      ...input.candidates.flatMap((candidate) => candidate.warnings),
      ...(input.rejected ?? []).flatMap((day) => day.reasons),
    ].flatMap(idTokensIn),
  ]);
  const warningsByDay = new Map(
    input.candidates.map((candidate) => [candidate.shootDayId, candidate.warnings.length]),
  );
  for (const entry of output.ranked) {
    assertHonestProse(
      "rankCandidates",
      entry.reason,
      { conflicts: 0, impacts: 0, warnings: warningsByDay.get(entry.shootDayId) ?? 0 },
      known,
    );
  }
};

/** Rejects a ranking that adds, drops, or duplicates a candidate, or leaves a gap in the ranks. */
const assertGroundedRanking = (
  input: RankCandidatesInput,
  output: RankedCandidatesOutput,
): void => {
  const offered = input.candidates.map((candidate) => candidate.shootDayId).sort();
  const returned = output.ranked.map((entry) => entry.shootDayId).sort();
  if (JSON.stringify(offered) !== JSON.stringify(returned)) {
    throw new ModelError(
      "UNGROUNDED_OUTPUT",
      "rankCandidates",
      "The ranking must be a permutation of the candidates it was given.",
      `offered ${offered.join(",")}; returned ${returned.join(",")}`,
    );
  }
  const ranks = output.ranked.map((entry) => entry.rank).sort((left, right) => left - right);
  if (ranks.some((rank, index) => rank !== index + 1)) {
    throw new ModelError(
      "MALFORMED_OUTPUT",
      "rankCandidates",
      "Ranks must be 1..n with no gaps or repeats.",
      ranks.join(","),
    );
  }
};

export type ModelGuardOptions = {
  /** Per-call budget. A model that does not answer in time is a provider fault, not a reason to wait. */
  readonly timeoutMs?: number;
  /** Logs one `model_call` line per call: operation, durationMs, outcome (TASK-804, ARCHITECTURE.md §16). */
  readonly logger?: Logger;
};

const withTimeout = async <T>(
  operation: keyof ModelPort,
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> => {
  if (timeoutMs === undefined) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ModelError("TIMEOUT", operation, `No answer within ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const callProvider = async <T>(
  operation: keyof ModelPort,
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  logger: Logger | undefined,
): Promise<T> => {
  const startedAt = Date.now();
  const record = (outcome: "ok" | "error"): void => {
    logger?.log("info", "model_call", {
      operation,
      outcome,
      durationMs: Date.now() - startedAt,
    });
  };
  try {
    const result = await withTimeout(operation, run(), timeoutMs);
    record("ok");
    return result;
  } catch (error) {
    record("error");
    if (error instanceof ModelError) {
      throw error;
    }
    throw new ModelError(
      "PROVIDER_ERROR",
      operation,
      "The model provider failed.",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const parseOr = <T>(
  operation: keyof ModelPort,
  parse: () =>
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
): T => {
  const result = parse();
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new ModelError(
    "MALFORMED_OUTPUT",
    operation,
    `The model's answer does not match the schema at "${issue?.path.join(".") ?? "<root>"}": ${issue?.message ?? "unknown issue"}.`,
  );
};

/**
 * Wraps any ModelPort so its answers are schema-validated and grounded before
 * anything downstream sees them. Adapters stay simple; the guarantee lives
 * here once.
 */
export const guardModelPort = (port: ModelPort, options: ModelGuardOptions = {}): ModelPort => ({
  interpretChange: async (input) => {
    const raw: unknown = await callProvider(
      "interpretChange",
      () => port.interpretChange(input),
      options.timeoutMs,
      options.logger,
    );
    const output = parseOr("interpretChange", () => interpretedChangeSchema.safeParse(raw));
    assertGroundedInterpretation(input, output);
    return output;
  },
  explainImpact: async (input) => {
    const raw: unknown = await callProvider(
      "explainImpact",
      () => port.explainImpact(input),
      options.timeoutMs,
      options.logger,
    );
    const output = parseOr("explainImpact", () => explanationOutputSchema.safeParse(raw));
    try {
      assertGroundedNarrative(input, output);
    } catch (error) {
      options.logger?.log("warn", "model_output_rejected", {
        operation: "explainImpact",
        reason: error instanceof ModelError ? (error.detail ?? error.code) : String(error),
      });
      throw error;
    }
    return output;
  },
  rankCandidates: async (input) => {
    const raw: unknown = await callProvider(
      "rankCandidates",
      () => port.rankCandidates(input),
      options.timeoutMs,
      options.logger,
    );
    const output = parseOr("rankCandidates", () => rankedCandidatesOutputSchema.safeParse(raw));
    assertGroundedRanking(input, output);
    try {
      assertGroundedReasons(input, output);
    } catch (error) {
      options.logger?.log("warn", "model_output_rejected", {
        operation: "rankCandidates",
        reason: error instanceof ModelError ? (error.detail ?? error.code) : String(error),
      });
      throw error;
    }
    return output;
  },
});
