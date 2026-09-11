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

/** `YYYY-MM-DD` that also survives a round trip: `2026-13-45` matches the shape and is not a date. */
const isRealDate = (date: string): boolean => {
  const parsed = new Date(`${date}T00:00:00Z`);
  // An invalid Date throws from toISOString rather than returning a mismatch.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

/** The words and dashes a sentence uses to join the two ends of a range. */
const RANGE_JOINER = "(?:to|through|thru|until|till|-|–|—)";

const MONTH_PATTERN = `(${MONTHS.join("|")})`;

const monthDayToIso = (month: string, day: string, today: LocalDate): LocalDate =>
  `${today.slice(0, 4)}-${pad(MONTHS.indexOf(month as (typeof MONTHS)[number]) + 1)}-${pad(Number(day))}`;

/** A validated closed range, or the reason it is not one. */
const rangeOf = (start: LocalDate, end: LocalDate): DateResolution => {
  for (const date of [start, end]) {
    if (!isRealDate(date)) {
      return { kind: "none", reason: `${date} is not a real date.` };
    }
  }
  if (end < start) {
    return { kind: "none", reason: `The range ends (${end}) before it starts (${start}).` };
  }
  return {
    kind: "one",
    range: { start, end },
    label: start === end ? start : `${start} to ${end}`,
  };
};

/**
 * Finds the date phrase the sentence carries and resolves it against the
 * production. Ranges are tried before single dates (TASK-908, code review
 * #9): "2026-09-18 to 2026-09-22" used to resolve to its first day alone,
 * silently understating a multi-day constraint the coordinator then approved.
 * Both ends of a range are validated, and an end before its start is refused.
 */
const resolveDate = (text: string, context: InterpretationContext): DateResolution => {
  const isoRange = new RegExp(
    `(\\d{4}-\\d{2}-\\d{2})\\s*${RANGE_JOINER}\\s*(\\d{4}-\\d{2}-\\d{2})`,
    "u",
  ).exec(text);
  if (isoRange?.[1] !== undefined && isoRange[2] !== undefined) {
    return rangeOf(isoRange[1], isoRange[2]);
  }
  const iso = /(\d{4}-\d{2}-\d{2})/u.exec(text);
  if (iso?.[1] !== undefined) {
    return rangeOf(iso[1], iso[1]);
  }

  // "September 18 to September 22", "September 18 through 22", "September 18–22".
  const monthDayRange = new RegExp(
    `${MONTH_PATTERN}\\s+(\\d{1,2})\\s*${RANGE_JOINER}\\s*(?:${MONTH_PATTERN}\\s+)?(\\d{1,2})\\b`,
    "u",
  ).exec(text);
  if (
    monthDayRange?.[1] !== undefined &&
    monthDayRange[2] !== undefined &&
    monthDayRange[4] !== undefined
  ) {
    return rangeOf(
      monthDayToIso(monthDayRange[1], monthDayRange[2], context.today),
      monthDayToIso(monthDayRange[3] ?? monthDayRange[1], monthDayRange[4], context.today),
    );
  }
  const monthDay = new RegExp(`${MONTH_PATTERN}\\s+(\\d{1,2})`, "u").exec(text);
  if (monthDay?.[1] !== undefined && monthDay[2] !== undefined) {
    const date = monthDayToIso(monthDay[1], monthDay[2], context.today);
    return rangeOf(date, date);
  }

  if (/\btoday\b/u.test(text)) {
    return { kind: "one", range: { start: context.today, end: context.today }, label: "today" };
  }
  if (/\btomorrow\b/u.test(text)) {
    const date = shiftDays(context.today, 1);
    return { kind: "one", range: { start: date, end: date }, label: "tomorrow" };
  }

  const shootDaysOn = (weekday: (typeof WEEKDAYS)[number]): LocalDate[] =>
    context.shootDays
      .filter((day) => weekdayOf(day.date) === WEEKDAYS.indexOf(weekday))
      .map((day) => day.date)
      .sort();

  // "Friday through Monday": the earliest shoot day on the first weekday, to
  // the first shoot day on the second weekday after it. A first weekday that
  // matches several shoot days is a question, not a guess.
  const weekdayRange = new RegExp(
    `\\b(${WEEKDAYS.join("|")})\\s*${RANGE_JOINER}\\s*(${WEEKDAYS.join("|")})\\b`,
    "u",
  ).exec(text);
  if (weekdayRange?.[1] !== undefined && weekdayRange[2] !== undefined) {
    const fromDay = weekdayRange[1] as (typeof WEEKDAYS)[number];
    const toDay = weekdayRange[2] as (typeof WEEKDAYS)[number];
    const starts = shootDaysOn(fromDay);
    const [start] = starts;
    if (start === undefined) {
      return { kind: "none", reason: `No shoot day falls on a ${fromDay}.` };
    }
    if (starts.length > 1) {
      return {
        kind: "none",
        reason: `More than one shoot day falls on a ${fromDay}; give the range as dates.`,
      };
    }
    const end = shootDaysOn(toDay).find((date) => date > start);
    if (end === undefined) {
      return { kind: "none", reason: `No shoot day falls on a ${toDay} after ${start}.` };
    }
    return rangeOf(start, end);
  }

  const weekday = WEEKDAYS.find((day) => new RegExp(`\\b${day}\\b`, "u").test(text));
  if (weekday === undefined) {
    return {
      kind: "none",
      reason: "No date, weekday, or 'today'/'tomorrow' was found in the sentence.",
    };
  }
  const matching = shootDaysOn(weekday).map((date) => ({
    range: { start: date, end: date },
    label: `${weekday} ${date}`,
  }));
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

/**
 * Negative intent only (TASK-908, code review #9). The previous pattern also
 * matched "is available" and "are available", so "Sarah is available Friday"
 * became CAST_UNAVAILABLE — the opposite of what was said, one approval away
 * from being recorded.
 */
const UNAVAILABLE =
  /\b(cannot|can't|can not|unable to|won't be able to|is not available|isn't available|are not available|aren't available|is unavailable|are unavailable|is out|is off|is closed|closed|unavailable|not available|off limits)\b/u;

/** Positive intent: understood, and refused, because no "available again" change exists yet. */
const AVAILABLE =
  /\b((?:is|are|will be|'s)\s+(?:now\s+|again\s+)?(?:available|free|back)|available again|can (?:now\s+)?(?:shoot|make|work|film))\b/u;

const interpretAvailability = (text: string, context: InterpretationContext): InterpretedChange => {
  if (!UNAVAILABLE.test(text)) {
    if (AVAILABLE.test(text)) {
      return unsupported(
        "The sentence says someone or somewhere is available. Only unavailability can be recorded today; there is no change type for becoming available again, so nothing was interpreted.",
      );
    }
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
