import type { ModelPort } from "@pca/application";
import type {
  DateRange,
  ExplainImpactInput,
  ExplanationOutput,
  InterpretChangeInput,
  InterpretationContext,
  InterpretedChange,
  LocalDate,
  RankCandidatesInput,
  RankedCandidatesOutput,
  RequirementType,
  TypedChange,
} from "@pca/contracts";

/**
 * Rule-based model adapter: the free runtime default (ARCHITECTURE.md §2).
 *
 * It handles the sentence shapes SPEC.md §5 documents and their close
 * variants, deterministically, with no network. Anything outside those shapes
 * is reported as UNSUPPORTED with a reason rather than guessed; a coordinator
 * who wants free-form language installs Ollama. Ambiguity is returned as
 * options, never resolved by picking the first match.
 *
 * Names resolve against the context the caller supplies; a bare weekday
 * resolves against the production's shoot days, not the calendar.
 */

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const weekdayOf = (date: LocalDate): number => new Date(`${date}T00:00:00Z`).getUTCDay();

const pad = (value: number): string => String(value).padStart(2, "0");

const shiftDays = (date: LocalDate, days: number): LocalDate =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

const normalise = (text: string): string =>
  text.toLowerCase().replace(/[’']/gu, "'").replace(/\s+/gu, " ").trim();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whole-word, case-insensitive containment. */
const mentions = (text: string, name: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalise(name))}([^a-z0-9]|$)`, "u").test(text);

type DateResolution =
  | { kind: "one"; range: DateRange; label: string }
  | { kind: "several"; ranges: { range: DateRange; label: string }[] }
  | { kind: "none"; reason: string };

/** Finds the one date phrase the sentence carries and resolves it against the production. */
const resolveDate = (text: string, context: InterpretationContext): DateResolution => {
  const iso = /(\d{4}-\d{2}-\d{2})/u.exec(text);
  if (iso?.[1] !== undefined) {
    return { kind: "one", range: { start: iso[1], end: iso[1] }, label: iso[1] };
  }

  const monthDay = new RegExp(`(${MONTHS.join("|")})\\s+(\\d{1,2})`, "u").exec(text);
  if (monthDay?.[1] !== undefined && monthDay[2] !== undefined) {
    const year = context.today.slice(0, 4);
    const date = `${year}-${pad(MONTHS.indexOf(monthDay[1] as (typeof MONTHS)[number]) + 1)}-${pad(Number(monthDay[2]))}`;
    return { kind: "one", range: { start: date, end: date }, label: date };
  }

  if (/\btoday\b/u.test(text)) {
    return { kind: "one", range: { start: context.today, end: context.today }, label: "today" };
  }
  if (/\btomorrow\b/u.test(text)) {
    const date = shiftDays(context.today, 1);
    return { kind: "one", range: { start: date, end: date }, label: "tomorrow" };
  }

  const weekday = WEEKDAYS.find((day) => new RegExp(`\\b${day}\\b`, "u").test(text));
  if (weekday === undefined) {
    return {
      kind: "none",
      reason: "No date, weekday, or 'today'/'tomorrow' was found in the sentence.",
    };
  }
  const matching = context.shootDays
    .filter((day) => weekdayOf(day.date) === WEEKDAYS.indexOf(weekday))
    .map((day) => ({ range: { start: day.date, end: day.date }, label: `${weekday} ${day.date}` }))
    .sort((left, right) => left.range.start.localeCompare(right.range.start));
  if (matching.length === 0) {
    return { kind: "none", reason: `No shoot day falls on a ${weekday}.` };
  }
  const [first] = matching;
  return matching.length === 1 && first !== undefined
    ? { kind: "one", range: first.range, label: first.label }
    : { kind: "several", ranges: matching };
};

const REQUIREMENT_TYPES: readonly { readonly type: RequirementType; readonly pattern: RegExp }[] = [
  {
    type: "WARDROBE",
    pattern: /\b(wardrobe|costume|dress|suit|outfit|coat|raincoat|jacket|hat|shoes|uniform)\b/u,
  },
  { type: "EQUIPMENT", pattern: /\b(camera|lens|rig|crane|dolly|drone)\b/u },
  { type: "VFX", pattern: /\b(vfx|green screen|effect)\b/u },
];

const requirementTypeFor = (name: string): RequirementType =>
  REQUIREMENT_TYPES.find((entry) => entry.pattern.test(name))?.type ?? "PROP";

const unsupported = (reason: string): InterpretedChange => ({ kind: "UNSUPPORTED", reason });

const interpretScene = (text: string, context: InterpretationContext): InterpretedChange | null => {
  const scene = /\bscene\s+(\d+)\b/u.exec(text);
  if (scene?.[1] === undefined) {
    return null;
  }
  const need =
    /\b(?:now\s+)?(?:needs?|requires?|will need|wants?)\s+(?:an?\s+|the\s+)?(.+?)[.!]?$/u.exec(
      text,
    ) ?? /\badd\s+(?:an?\s+|the\s+)?(.+?)\s+to\s+scene\b/u.exec(text);
  if (need?.[1] === undefined) {
    return unsupported(
      "Scene sentences are understood as 'Scene N now needs a <thing>' or 'Add <thing> to scene N'.",
    );
  }
  const wanted = String(Number(scene[1]));
  const matches = context.scenes.filter(
    (candidate) => String(Number(candidate.sceneNumber)) === wanted,
  );
  if (matches.length === 0) {
    return unsupported(`No scene numbered ${scene[1]} exists in this production.`);
  }
  const name = need[1].trim();
  const change = (sceneId: string): TypedChange => ({
    type: "SCENE_REQUIREMENT_CHANGED",
    sceneId,
    requirement: { type: requirementTypeFor(name), name },
  });
  if (matches.length > 1) {
    return {
      kind: "AMBIGUOUS",
      question: `Several scenes are numbered ${scene[1]}. Which one?`,
      options: matches.map((candidate) => ({
        label: candidate.title ?? candidate.id,
        change: change(candidate.id),
      })),
    };
  }
  const [only] = matches;
  return only === undefined ? null : { kind: "RESOLVED", change: change(only.id), confidence: 0.9 };
};

const UNAVAILABLE =
  /\b(cannot|can't|can not|unable to|won't be able to|is (?:not )?(?:un)?available|are (?:un)?available|isn't available|is out|is off|is closed|closed|unavailable|not available|off limits)\b/u;

const interpretAvailability = (text: string, context: InterpretationContext): InterpretedChange => {
  if (!UNAVAILABLE.test(text)) {
    return unsupported(
      "Availability sentences are understood as '<Name> cannot shoot <day>' or '<Place> is unavailable <day>'.",
    );
  }

  const castMatches = context.castMembers.filter(
    (cast) =>
      mentions(text, cast.name) || (cast.roleName !== undefined && mentions(text, cast.roleName)),
  );
  const locationMatches = context.locations.filter((location) => mentions(text, location.name));
  if (castMatches.length === 0 && locationMatches.length === 0) {
    return unsupported(
      "No cast member or location named in the sentence exists in this production.",
    );
  }

  const when = resolveDate(text, context);
  if (when.kind === "none") {
    return unsupported(when.reason);
  }

  const subjects: { label: string; change: (range: DateRange) => TypedChange }[] = [
    ...castMatches.map((cast) => ({
      label: cast.name,
      change: (range: DateRange): TypedChange => ({
        type: "CAST_UNAVAILABLE",
        castId: cast.id,
        unavailable: range,
      }),
    })),
    ...locationMatches.map((location) => ({
      label: location.name,
      change: (range: DateRange): TypedChange => ({
        type: "LOCATION_UNAVAILABLE",
        locationId: location.id,
        unavailable: range,
      }),
    })),
  ];
  const ranges = when.kind === "one" ? [{ range: when.range, label: when.label }] : when.ranges;

  const first = subjects[0];
  const firstRange = ranges[0];
  if (
    subjects.length === 1 &&
    ranges.length === 1 &&
    first !== undefined &&
    firstRange !== undefined
  ) {
    return { kind: "RESOLVED", change: first.change(firstRange.range), confidence: 0.9 };
  }

  const options = subjects.flatMap((subject) =>
    ranges.map((entry) => ({
      label: `${subject.label}, ${entry.label}`,
      change: subject.change(entry.range),
    })),
  );
  return {
    kind: "AMBIGUOUS",
    question:
      subjects.length > 1
        ? "The sentence could refer to more than one person or place. Which one?"
        : "More than one shoot day matches that weekday. Which one?",
    options: options.slice(0, 6),
  };
};

export const interpretWithRules = (input: InterpretChangeInput): InterpretedChange => {
  const text = normalise(input.text);
  return interpretScene(text, input.context) ?? interpretAvailability(text, input.context);
};

/** Prose assembled from findings, never from imagination. */
export const explainWithRules = (input: ExplainImpactInput): ExplanationOutput => {
  const blocking = input.impacts.filter((impact) => impact.severity === "BLOCKING");
  const warnings = input.impacts.filter((impact) => impact.severity === "WARNING");
  const parts: string[] = [];
  if (blocking.length > 0) {
    parts.push(
      `${blocking.length} blocking ${blocking.length === 1 ? "conflict" : "conflicts"}: ${blocking.map((impact) => impact.explanation).join(" ")}`,
    );
  }
  if (warnings.length > 0) {
    parts.push(
      `${warnings.length} ${warnings.length === 1 ? "item needs" : "items need"} attention: ${warnings.map((impact) => impact.explanation).join(" ")}`,
    );
  }
  if ((input.resolvedConflicts?.length ?? 0) > 0) {
    parts.push(
      `Applying this resolves ${input.resolvedConflicts?.length} existing ${input.resolvedConflicts?.length === 1 ? "conflict" : "conflicts"}.`,
    );
  }
  if (parts.length === 0) {
    parts.push("No conflicts or warnings were found.");
  }
  return { explanation: parts.join(" ").slice(0, 2000) };
};

/** Fewest warnings first, then earliest date. Every reason cites the data. */
export const rankWithRules = (input: RankCandidatesInput): RankedCandidatesOutput => {
  const ordered = [...input.candidates].sort(
    (left, right) =>
      left.warnings.length - right.warnings.length || left.date.localeCompare(right.date),
  );
  return {
    ranked: ordered.map((candidate, index) => ({
      shootDayId: candidate.shootDayId,
      rank: index + 1,
      reason:
        candidate.warnings.length === 0
          ? `${candidate.date} has no warnings.`
          : `${candidate.date} has ${candidate.warnings.length} ${candidate.warnings.length === 1 ? "warning" : "warnings"}: ${candidate.warnings[0]}`,
    })),
  };
};

export const createRuleModelAdapter = (): ModelPort => ({
  interpretChange: (input) => Promise.resolve(interpretWithRules(input)),
  explainImpact: (input) => Promise.resolve(explainWithRules(input)),
  rankCandidates: (input) => Promise.resolve(rankWithRules(input)),
});
