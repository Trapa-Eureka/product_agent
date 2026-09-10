import type { DateRange, LocalDate } from "@pca/contracts";

/**
 * Production-local calendar arithmetic.
 *
 * Dates here are `YYYY-MM-DD` in the production's timezone and never carry a
 * time. Comparing them lexicographically is exact, which is why this module
 * needs no date library and no timezone conversion: a shoot day is a calendar
 * day, not an instant.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Guards against a caller asking to enumerate an unbounded window. */
const MAX_RANGE_DAYS = 366;

const MS_PER_DAY = 86_400_000;

const toUtcMillis = (date: LocalDate): number => {
  const match = DATE_PATTERN.exec(date);
  if (match === null) {
    throw new RangeError(`Expected a YYYY-MM-DD production-local date, received "${date}".`);
  }
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
};

const fromUtcMillis = (millis: number): LocalDate => {
  const iso = new Date(millis).toISOString();
  return iso.slice(0, 10);
};

/** Inclusive on both ends, matching how a coordinator reads "unavailable Fri to Mon". */
export const isDateWithin = (date: LocalDate, range: DateRange): boolean =>
  range.start <= date && date <= range.end;

/** True when any of the windows covers the date. */
export const isBlockedOn = (windows: readonly DateRange[], date: LocalDate): boolean =>
  windows.some((window) => isDateWithin(date, window));

/** Every calendar day from `from` to `to`, inclusive. */
export const eachDateBetween = (from: LocalDate, to: LocalDate): LocalDate[] => {
  const start = toUtcMillis(from);
  const end = toUtcMillis(to);
  if (end < start) {
    throw new RangeError(`Range end "${to}" is before its start "${from}".`);
  }
  const dayCount = (end - start) / MS_PER_DAY + 1;
  if (dayCount > MAX_RANGE_DAYS) {
    throw new RangeError(
      `Refusing to enumerate ${dayCount} days; the limit is ${MAX_RANGE_DAYS}. Narrow the window.`,
    );
  }

  const dates: LocalDate[] = [];
  for (let millis = start; millis <= end; millis += MS_PER_DAY) {
    dates.push(fromUtcMillis(millis));
  }
  return dates;
};

/**
 * The blocked days inside a window, listed explicitly.
 *
 * Callers get the dates rather than the ranges so nobody has to infer
 * unavailability from a gap between two ranges.
 */
export const blockedDatesWithin = (
  windows: readonly DateRange[],
  from: LocalDate,
  to: LocalDate,
): LocalDate[] => eachDateBetween(from, to).filter((date) => isBlockedOn(windows, date));

/** True when the existing windows already block every day of the range. */
export const isRangeCovered = (windows: readonly DateRange[], range: DateRange): boolean =>
  normalizeDateRanges(windows).some(
    (window) => window.start <= range.start && range.end <= window.end,
  );

/** Merges overlapping or adjacent windows so availability data stays comparable. */
export const normalizeDateRanges = (windows: readonly DateRange[]): DateRange[] => {
  const sorted = [...windows].sort((left, right) =>
    left.start === right.start
      ? left.end.localeCompare(right.end)
      : left.start.localeCompare(right.start),
  );

  const merged: DateRange[] = [];
  for (const window of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push({ ...window });
      continue;
    }
    const dayAfterPrevious = fromUtcMillis(toUtcMillis(previous.end) + MS_PER_DAY);
    if (window.start <= dayAfterPrevious) {
      previous.end = window.end > previous.end ? window.end : previous.end;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
};
