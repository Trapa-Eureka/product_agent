import type { ChangeType, TypedChange } from "@pca/contracts";

/**
 * Renders a `TypedChange` for the detected-change card (DESIGN.md §3,
 * TASK-502): normalized type, resolved entity, date/scene.
 *
 * A typed change never carries a name (DOMAIN.md, CLAUDE.md rule 5): by the
 * time one exists, "Sarah" has already become `CAST-SARAH`. This module does
 * not try to resolve that ID back to a name — there is no client-side route
 * for it, and guessing would be exactly the kind of silent resolution the
 * product refuses to do (DESIGN.md §3, "do not hide ambiguity"). It shows
 * the resolved reference honestly instead, labelled by kind. Confidence is
 * not shown: the model's confidence score is not part of the persisted
 * `ChangeRequest`, so there is nothing here to read it from.
 *
 * Pure functions of data, so they are unit-tested without Angular.
 */

export type ChangeField = { readonly label: string; readonly value: string };

export type FormattedChange = {
  readonly typeLabel: string;
  readonly fields: readonly ChangeField[];
};

const CHANGE_TYPE_LABELS: Readonly<Record<ChangeType, string>> = {
  CAST_UNAVAILABLE: "Cast unavailable",
  LOCATION_UNAVAILABLE: "Location unavailable",
  SCENE_REQUIREMENT_CHANGED: "Scene requirement changed",
  SCHEDULE_CHANGED: "Schedule changed",
};

export const formatChangeType = (type: ChangeType): string => CHANGE_TYPE_LABELS[type];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-18` → `Fri, Sep 18, 2026`. Parsed as UTC so the calendar date never shifts. */
export const formatLocalDate = (date: string): string => {
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
  return `${weekday}, ${monthName} ${day}, ${year}`;
};

/** A single day reads as one date; a span reads as a range. */
export const formatDateRange = (range: { readonly start: string; readonly end: string }): string =>
  range.start === range.end
    ? formatLocalDate(range.start)
    : `${formatLocalDate(range.start)} – ${formatLocalDate(range.end)}`;

const REQUIREMENT_TYPE_LABELS: Record<string, string> = {
  PROP: "Prop",
  WARDROBE: "Wardrobe",
  EQUIPMENT: "Equipment",
  VEHICLE: "Vehicle",
  VFX: "VFX",
  OTHER: "Other",
};

/** The fields DESIGN.md §3 wants: resolved entity, date/scene, kind-specific detail. */
export const formatTypedChange = (change: TypedChange): FormattedChange => {
  const typeLabel = formatChangeType(change.type);
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return {
        typeLabel,
        fields: [
          { label: "Cast", value: change.castId },
          { label: "Unavailable", value: formatDateRange(change.unavailable) },
        ],
      };
    case "LOCATION_UNAVAILABLE":
      return {
        typeLabel,
        fields: [
          { label: "Location", value: change.locationId },
          { label: "Unavailable", value: formatDateRange(change.unavailable) },
        ],
      };
    case "SCENE_REQUIREMENT_CHANGED":
      return {
        typeLabel,
        fields: [
          { label: "Scene", value: change.sceneId },
          {
            label: REQUIREMENT_TYPE_LABELS[change.requirement.type] ?? change.requirement.type,
            value: change.requirement.name,
          },
        ],
      };
    case "SCHEDULE_CHANGED":
      return {
        typeLabel,
        fields: [
          {
            label: change.sceneIds.length === 1 ? "Scene" : "Scenes",
            value: change.sceneIds.join(", "),
          },
          { label: "To shoot day", value: change.toShootDayId },
        ],
      };
  }
};

/** A one-line summary for contexts too small for the full field list (e.g. an ambiguity option). */
export const summarizeTypedChange = (change: TypedChange): string =>
  formatTypedChange(change)
    .fields.map((field) => `${field.label}: ${field.value}`)
    .join(" · ");
