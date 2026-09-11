import type {
  Conflict,
  DateRange,
  EntityId,
  ExplanationEffect,
  Impact,
  ImpactExplanation,
  LocalDate,
  ProposalExplanation,
  ProposedOperation,
  TypedChange,
} from "@pca/contracts";
import type { ProductionIndex, ProductionState } from "@pca/domain";
import { indexProduction, isBlockedOn } from "@pca/domain";

/**
 * Explanation layer (TASK-306, DESIGN.md §3 and §4).
 *
 * Turns deterministic results into the two cards a coordinator reads: the
 * impact panel (what is blocked, what is affected, why) and the proposal card
 * (headline, effects, operations). Every line is assembled from the
 * production snapshot, the operations, and the engine's findings. A model may
 * contribute a narrative paragraph; it cannot add an effect or an operation.
 *
 * Pure functions on data. No ports, no clock, no model.
 */

/** The findings a proposal explanation is allowed to cite. */
export type ExplanationEvidence = {
  readonly impacts: readonly Impact[];
  readonly conflicts: readonly Conflict[];
  readonly resolvedConflicts: readonly Conflict[];
  readonly warnings: readonly string[];
};

export type DescribeProposalInput = {
  readonly state: ProductionState;
  readonly operations: readonly ProposedOperation[];
  /** Simulation findings. Without them the card still lists effects derivable from the operations alone. */
  readonly simulation?: ExplanationEvidence;
  /** Model prose, already grounded by the model guard. */
  readonly narrative?: string;
};

export type DescribeImpactInput = {
  readonly state: ProductionState;
  readonly impacts: readonly Impact[];
  readonly conflicts: readonly Conflict[];
  /** Names the subject of a blocking summary ("Sarah's availability") when known. */
  readonly change?: TypedChange;
};

/** Longest text `proposalSchema.summary` accepts. */
export const PROPOSAL_SUMMARY_MAX_LENGTH = 2000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-18` → `Fri Sep 18`. Computed in UTC so the calendar date never shifts. */
export const formatShootDate = (date: LocalDate): string => {
  const [year, month, day] = date.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    Number.isNaN(year + month + day)
  ) {
    return date;
  }
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  const monthName = MONTHS[month - 1] ?? "";
  return `${weekday} ${monthName} ${day}`.trim();
};

const formatRange = (range: DateRange): string =>
  range.start === range.end
    ? formatShootDate(range.start)
    : `${formatShootDate(range.start)} to ${formatShootDate(range.end)}`;

/** `A`, `A and B`, `A, B and C`. */
const joinNames = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const sceneLabel = (index: ProductionIndex, sceneId: EntityId): string => {
  const scene = index.sceneById.get(sceneId);
  return scene === undefined ? sceneId : `Scene ${scene.sceneNumber}`;
};

const dayLabel = (index: ProductionIndex, shootDayId: EntityId): string => {
  const day = index.shootDayById.get(shootDayId);
  return day === undefined ? shootDayId : formatShootDate(day.date);
};

const castName = (index: ProductionIndex, castId: EntityId): string =>
  index.castById.get(castId)?.name ?? castId;

const locationName = (index: ProductionIndex, locationId: EntityId): string =>
  index.locationById.get(locationId)?.name ?? locationId;

const callSheetLabel = (index: ProductionIndex, callSheetId: EntityId): string => {
  const sheet = index.callSheetById.get(callSheetId);
  return sheet === undefined
    ? `Call sheet ${callSheetId}`
    : `Call sheet ${dayLabel(index, sheet.shootDayId)}`;
};

const requirementLabel = (operation: {
  readonly requirementType: string;
  readonly name: string;
}): string => `${operation.requirementType.toLowerCase()} "${operation.name}"`;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** One line per concrete step, in the order the operation would perform them. */
const operationLines = (index: ProductionIndex, operation: ProposedOperation): string[] => {
  switch (operation.type) {
    case "RECORD_CAST_UNAVAILABILITY":
      return [
        `record ${castName(index, operation.castId)} unavailable ${formatRange(operation.unavailable)}`,
      ];
    case "RECORD_LOCATION_UNAVAILABILITY":
      return [
        `record ${locationName(index, operation.locationId)} unavailable ${formatRange(operation.unavailable)}`,
      ];
    case "MOVE_SCENES":
      return [
        ...operation.sceneIds.map(
          (sceneId) =>
            `remove ${sceneLabel(index, sceneId)} from ${dayLabel(index, operation.fromShootDayId)}`,
        ),
        ...operation.sceneIds.map(
          (sceneId) =>
            `add ${sceneLabel(index, sceneId)} to ${dayLabel(index, operation.toShootDayId)}`,
        ),
      ];
    case "ADD_SCENE_REQUIREMENT":
      return [`add ${requirementLabel(operation)} to ${sceneLabel(index, operation.sceneId)}`];
    case "CREATE_PREPARATION_TASK":
      return [`create task "${operation.title}"`];
    case "MARK_CALL_SHEET_STALE":
      return [`mark ${callSheetLabel(index, operation.callSheetId)} for regeneration`];
  }
};

/** The remedy names the proposal; a fact-only proposal is named by its fact. */
const headlineFor = (index: ProductionIndex, operations: readonly ProposedOperation[]): string => {
  const remedies: string[] = [];
  const facts: string[] = [];
  for (const operation of operations) {
    switch (operation.type) {
      case "MOVE_SCENES":
        remedies.push(
          `Move ${joinNames(operation.sceneIds.map((sceneId) => sceneLabel(index, sceneId)))} from ${dayLabel(index, operation.fromShootDayId)} → ${dayLabel(index, operation.toShootDayId)}`,
        );
        break;
      case "ADD_SCENE_REQUIREMENT":
        remedies.push(
          `Add ${requirementLabel(operation)} to ${sceneLabel(index, operation.sceneId)}`,
        );
        break;
      case "RECORD_CAST_UNAVAILABILITY":
        facts.push(
          `Record ${castName(index, operation.castId)} unavailable ${formatRange(operation.unavailable)}`,
        );
        break;
      case "RECORD_LOCATION_UNAVAILABILITY":
        facts.push(
          `Record ${locationName(index, operation.locationId)} unavailable ${formatRange(operation.unavailable)}`,
        );
        break;
      default:
        break;
    }
  }
  if (remedies.length > 0) return remedies.join("; ");
  if (facts.length > 0) return facts.join("; ");
  const first = operations.flatMap((operation) => operationLines(index, operation))[0];
  return first === undefined ? "No operations" : capitalize(first);
};

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

type RecordedRanges = {
  readonly cast: ReadonlyMap<EntityId, readonly DateRange[]>;
  readonly location: ReadonlyMap<EntityId, readonly DateRange[]>;
};

/** Availability the proposal itself records, so a resolved conflict can be attributed to the right person or place. */
const recordedRanges = (operations: readonly ProposedOperation[]): RecordedRanges => {
  const cast = new Map<EntityId, DateRange[]>();
  const location = new Map<EntityId, DateRange[]>();
  for (const operation of operations) {
    if (operation.type === "RECORD_CAST_UNAVAILABILITY") {
      cast.set(operation.castId, [...(cast.get(operation.castId) ?? []), operation.unavailable]);
    } else if (operation.type === "RECORD_LOCATION_UNAVAILABILITY") {
      location.set(operation.locationId, [
        ...(location.get(operation.locationId) ?? []),
        operation.unavailable,
      ]);
    }
  }
  return { cast, location };
};

type ConflictSubject = {
  readonly key: string;
  readonly name: string;
  readonly entityType: ExplanationEffect["entityType"];
  readonly entityId: EntityId;
};

/** Who or what a scheduling conflict is really about: the person or place, not the scene that reports it. */
const conflictSubjects = (
  index: ProductionIndex,
  recorded: RecordedRanges,
  conflict: Conflict,
): ConflictSubject[] => {
  const scene = index.sceneById.get(conflict.entityId);
  if (scene === undefined || conflict.date === undefined) return [];
  const date = conflict.date;
  switch (conflict.code) {
    case "CAST_UNAVAILABLE_ON_SHOOT_DAY":
      return scene.requiredCastIds
        .map((castId) => index.castById.get(castId))
        .filter((cast) => cast !== undefined)
        .filter((cast) =>
          isBlockedOn([...cast.unavailable, ...(recorded.cast.get(cast.id) ?? [])], date),
        )
        .map((cast) => ({
          key: `CAST:${cast.id}`,
          name: cast.name,
          entityType: "CAST_MEMBER",
          entityId: cast.id,
        }));
    case "LOCATION_UNAVAILABLE_ON_SHOOT_DAY": {
      const location = index.locationById.get(scene.locationId);
      return location === undefined
        ? []
        : [
            {
              key: `LOCATION:${location.id}`,
              name: location.name,
              entityType: "LOCATION",
              entityId: location.id,
            },
          ];
    }
    default:
      return [];
  }
};

const resolvedEffects = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
  resolved: readonly Conflict[],
): ExplanationEffect[] => {
  const recorded = recordedRanges(operations);
  const groups = new Map<string, { subject: ConflictSubject; scenes: string[] }>();
  const other: ExplanationEffect[] = [];
  for (const conflict of resolved) {
    const subjects = conflictSubjects(index, recorded, conflict);
    if (subjects.length === 0) {
      other.push({
        tone: "POSITIVE",
        text: `resolves: ${conflict.detail}`,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
      });
      continue;
    }
    for (const subject of subjects) {
      const group = groups.get(subject.key) ?? { subject, scenes: [] };
      group.scenes.push(sceneLabel(index, conflict.entityId));
      groups.set(subject.key, group);
    }
  }
  return [
    ...[...groups.values()].map(({ subject, scenes }) => ({
      tone: "POSITIVE" as const,
      text: `resolves ${subject.name} conflict on ${joinNames(unique(scenes))}`,
      ...(subject.entityType === undefined ? {} : { entityType: subject.entityType }),
      entityId: subject.entityId,
    })),
    ...other,
  ];
};

/** What a move asks of the target day: the place must be free, and the people must be there. */
const targetDayEffects = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
): { positive: ExplanationEffect[]; attention: ExplanationEffect[] } => {
  const positive: ExplanationEffect[] = [];
  const attention: ExplanationEffect[] = [];
  for (const operation of operations) {
    if (operation.type !== "MOVE_SCENES") continue;
    const target = index.shootDayById.get(operation.toShootDayId);
    if (target === undefined) continue;
    const when = formatShootDate(target.date);
    const scenes = operation.sceneIds
      .map((sceneId) => index.sceneById.get(sceneId))
      .filter((scene) => scene !== undefined);
    for (const locationId of unique(scenes.map((scene) => scene.locationId))) {
      const location = index.locationById.get(locationId);
      if (location === undefined) continue;
      const blocked = isBlockedOn(location.unavailable, target.date);
      (blocked ? attention : positive).push({
        tone: blocked ? "ATTENTION" : "POSITIVE",
        text: `${location.name} is ${blocked ? "unavailable" : "available"} ${when}`,
        entityType: "LOCATION",
        entityId: location.id,
      });
    }
    for (const castId of unique(scenes.flatMap((scene) => scene.requiredCastIds))) {
      const cast = index.castById.get(castId);
      if (cast === undefined) continue;
      const blocked = isBlockedOn(cast.unavailable, target.date);
      attention.push({
        tone: "ATTENTION",
        text: blocked ? `${cast.name} is unavailable ${when}` : `${cast.name} is required ${when}`,
        entityType: "CAST_MEMBER",
        entityId: cast.id,
      });
    }
  }
  return { positive, attention };
};

/** Reason codes whose story the card already tells from the operations themselves. */
const COVERED_WARNING_CODES: ReadonlySet<Impact["reasonCode"]> = new Set([
  "CALL_SHEET_DERIVED_FROM_AFFECTED_SHOOT_DAY",
  "SHOOT_DAY_CONTAINS_AFFECTED_SCENE",
  "CAST_REQUIRED_ON_TARGET_DAY",
  "LOCATION_REQUIRED_ON_TARGET_DAY",
]);

const operationEffects = (
  index: ProductionIndex,
  operations: readonly ProposedOperation[],
): { positive: ExplanationEffect[]; attention: ExplanationEffect[] } => {
  const positive: ExplanationEffect[] = [];
  const attention: ExplanationEffect[] = [];
  for (const operation of operations) {
    switch (operation.type) {
      case "RECORD_CAST_UNAVAILABILITY":
        positive.push({
          tone: "POSITIVE",
          text: `${castName(index, operation.castId)} is recorded unavailable ${formatRange(operation.unavailable)}`,
          entityType: "CAST_MEMBER",
          entityId: operation.castId,
        });
        break;
      case "RECORD_LOCATION_UNAVAILABILITY":
        positive.push({
          tone: "POSITIVE",
          text: `${locationName(index, operation.locationId)} is recorded unavailable ${formatRange(operation.unavailable)}`,
          entityType: "LOCATION",
          entityId: operation.locationId,
        });
        break;
      case "ADD_SCENE_REQUIREMENT": {
        const day = index.shootDaysBySceneId.get(operation.sceneId)?.[0];
        attention.push({
          tone: "ATTENTION",
          text:
            day === undefined
              ? `${requirementLabel(operation)} must be ready before ${sceneLabel(index, operation.sceneId)} shoots`
              : `${requirementLabel(operation)} must be ready by ${formatShootDate(day.date)}`,
          entityType: "SCENE",
          entityId: operation.sceneId,
        });
        break;
      }
      case "MARK_CALL_SHEET_STALE":
        attention.push({
          tone: "ATTENTION",
          text: `${callSheetLabel(index, operation.callSheetId)} must be regenerated`,
          entityType: "CALL_SHEET",
          entityId: operation.callSheetId,
        });
        break;
      case "CREATE_PREPARATION_TASK":
        attention.push({
          tone: "ATTENTION",
          text: `new task: ${operation.title}`,
          entityType: operation.relatedEntityType,
          entityId: operation.relatedEntityId,
        });
        break;
      default:
        break;
    }
  }
  return { positive, attention };
};

const dedupe = (effects: readonly ExplanationEffect[]): ExplanationEffect[] => {
  const seen = new Set<string>();
  return effects.filter((effect) => {
    if (seen.has(effect.text)) return false;
    seen.add(effect.text);
    return true;
  });
};

/** Builds the proposal card. Deterministic: same state, operations, and findings give the same card. */
export const describeProposal = (input: DescribeProposalInput): ProposalExplanation => {
  const index = indexProduction(input.state);
  const { operations, simulation } = input;

  const resolved = resolvedEffects(index, operations, simulation?.resolvedConflicts ?? []);
  const target = targetDayEffects(index, operations);
  const own = operationEffects(index, operations);

  const remaining = (simulation?.conflicts ?? []).map((conflict): ExplanationEffect => ({
    tone: "ATTENTION",
    text: `conflict remains: ${conflict.detail}`,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
  }));
  const impactTexts = new Set((simulation?.impacts ?? []).map((impact) => impact.explanation));
  const otherWarnings = (simulation?.impacts ?? [])
    .filter(
      (impact) => impact.severity === "WARNING" && !COVERED_WARNING_CODES.has(impact.reasonCode),
    )
    .map((impact): ExplanationEffect => ({
      tone: "ATTENTION",
      text: impact.explanation,
      entityType: impact.entityType,
      entityId: impact.entityId,
    }));
  // Warnings that are not impact explanations are operations the simulator skipped.
  const skipped = (simulation?.warnings ?? [])
    .filter((warning) => !impactTexts.has(warning))
    .map((warning): ExplanationEffect => ({ tone: "ATTENTION", text: warning }));

  const effects = dedupe([
    ...resolved,
    ...target.positive,
    ...own.positive,
    ...remaining,
    ...target.attention,
    ...otherWarnings,
    ...skipped,
    ...own.attention,
  ]);

  return {
    headline: headlineFor(index, operations),
    effects,
    operations: operations.flatMap((operation) => operationLines(index, operation)),
    ...(input.narrative === undefined ? {} : { narrative: input.narrative }),
  };
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const EFFECT_MARK: Record<ExplanationEffect["tone"], string> = {
  POSITIVE: "+",
  ATTENTION: "!",
};

/** The DESIGN.md §4 text form. */
export const renderProposalExplanation = (
  explanation: ProposalExplanation,
  options: { readonly label?: string } = {},
): string => {
  const lines: string[] = [];
  if (options.label !== undefined) lines.push(options.label);
  lines.push(explanation.headline, "", "Effects");
  if (explanation.effects.length === 0) {
    lines.push("(none)");
  } else {
    for (const effect of explanation.effects) {
      lines.push(`${EFFECT_MARK[effect.tone]} ${effect.text}`);
    }
  }
  lines.push("", "Operations");
  for (const operation of explanation.operations) {
    lines.push(`- ${operation}`);
  }
  if (explanation.narrative !== undefined) {
    lines.push("", explanation.narrative);
  }
  return lines.join("\n");
};

/** The rendered card, clipped to what a proposal's `summary` field can hold. */
export const toProposalSummary = (explanation: ProposalExplanation): string => {
  const text = renderProposalExplanation(explanation);
  return text.length <= PROPOSAL_SUMMARY_MAX_LENGTH
    ? text
    : `${text.slice(0, PROPOSAL_SUMMARY_MAX_LENGTH - 1)}…`;
};

// ---------------------------------------------------------------------------
// Impact panel
// ---------------------------------------------------------------------------

/**
 * One deterministic line for what a typed change asks (TASK-922): the audit
 * trail files a change request under this rather than under a copy of the
 * sentence, so the story still reads ("Sarah unavailable Fri Sep 18") while
 * the raw text lives in one place only.
 */
export const describeTypedChange = (index: ProductionIndex, change: TypedChange): string => {
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return `${castName(index, change.castId)} unavailable ${formatRange(change.unavailable)}`;
    case "LOCATION_UNAVAILABLE":
      return `${locationName(index, change.locationId)} unavailable ${formatRange(change.unavailable)}`;
    case "SCENE_REQUIREMENT_CHANGED": {
      const scene = index.sceneById.get(change.sceneId);
      return `Scene ${scene?.sceneNumber ?? change.sceneId} needs ${change.requirement.name} (${change.requirement.type.toLowerCase()})`;
    }
    case "SCHEDULE_CHANGED": {
      const day = index.shootDayById.get(change.toShootDayId);
      const scenes = change.sceneIds.map(
        (sceneId) => `Scene ${index.sceneById.get(sceneId)?.sceneNumber ?? sceneId}`,
      );
      return `${scenes.join(", ")} to ${day === undefined ? change.toShootDayId : formatShootDate(day.date)}`;
    }
  }
};

const subjectOf = (index: ProductionIndex, change: TypedChange | undefined): string | null => {
  if (change === undefined) return null;
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return castName(index, change.castId);
    case "LOCATION_UNAVAILABLE":
      return locationName(index, change.locationId);
    default:
      return null;
  }
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** Builds the impact panel: a count per blocking reason, the affected entities by kind, and the engine's reasons. */
export const describeImpact = (input: DescribeImpactInput): ImpactExplanation => {
  const index = indexProduction(input.state);
  const subject = subjectOf(index, input.change);

  const blockingByCode = new Map<Impact["reasonCode"], number>();
  for (const impact of input.impacts) {
    if (impact.severity !== "BLOCKING") continue;
    blockingByCode.set(impact.reasonCode, (blockingByCode.get(impact.reasonCode) ?? 0) + 1);
  }
  const blocking = [...blockingByCode.entries()].map(([code, count]) => {
    switch (code) {
      case "SCENE_REQUIRES_UNAVAILABLE_CAST":
        return `${plural(count, "scheduled scene")} ${count === 1 ? "conflicts" : "conflict"} with ${subject === null ? "cast" : `${subject}'s`} availability.`;
      case "SCENE_AT_UNAVAILABLE_LOCATION":
        return `${plural(count, "scheduled scene")} ${count === 1 ? "conflicts" : "conflict"} with ${subject === null ? "location" : `${subject}'s`} availability.`;
      default:
        return `${plural(count, "blocking issue")}: ${code}.`;
    }
  });
  // Conflicts with no blocking impact behind them (a stale version, an unknown
  // reference) are reported by their own detail.
  if (blockingByCode.size === 0) {
    blocking.push(...input.conflicts.map((conflict) => conflict.detail));
  }

  const byType = (entityType: Impact["entityType"], label: (id: EntityId) => string): string[] =>
    unique(
      input.impacts
        .filter((impact) => impact.entityType === entityType)
        .map((impact) => label(impact.entityId)),
    );

  return {
    blocking: unique(blocking),
    affected: {
      scenes: byType("SCENE", (id) => index.sceneById.get(id)?.sceneNumber ?? id),
      shootDays: byType("SHOOT_DAY", (id) => dayLabel(index, id)),
      callSheets: byType("CALL_SHEET", (id) => callSheetLabel(index, id)),
      tasks: byType("TASK", (id) => {
        const task = input.state.tasks.find((candidate) => candidate.id === id);
        return task === undefined ? id : task.title;
      }),
      castMembers: byType("CAST_MEMBER", (id) => castName(index, id)),
      locations: byType("LOCATION", (id) => locationName(index, id)),
    },
    why: unique(input.impacts.map((impact) => impact.explanation)),
  };
};

/** The DESIGN.md §3 text form. Empty groups are omitted. */
export const renderImpactExplanation = (explanation: ImpactExplanation): string => {
  const lines: string[] = [];
  if (explanation.blocking.length > 0) {
    lines.push("BLOCKING", ...explanation.blocking, "");
  }
  const groups: [string, readonly string[]][] = [
    ["Scenes", explanation.affected.scenes],
    ["Shoot days", explanation.affected.shootDays],
    ["Call sheets", explanation.affected.callSheets],
    ["Tasks", explanation.affected.tasks],
    ["Cast", explanation.affected.castMembers],
    ["Locations", explanation.affected.locations],
  ];
  const affected = groups
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => `${name}: ${items.join(", ")}`);
  lines.push("AFFECTED", ...(affected.length === 0 ? ["(none)"] : affected), "");
  lines.push("WHY", ...(explanation.why.length === 0 ? ["(none)"] : explanation.why));
  return lines.join("\n");
};
