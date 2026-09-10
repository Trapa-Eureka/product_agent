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
    return parseOr("explainImpact", () => explanationOutputSchema.safeParse(raw));
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
    return output;
  },
});
