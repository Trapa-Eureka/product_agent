import type { AuditEvent } from "@pca/contracts";

/**
 * The Audit view (DESIGN.md §7, TASK-508): "make the agent trustworthy."
 * Every line here is a deterministic, structured fact from an `AuditEvent`
 * — never a model's own words, and never its reasoning (ARCHITECTURE.md
 * §15, "audit records ... never hold model chain-of-thought"). Pure
 * functions of one event, so they are unit-tested without Angular.
 */

const actorLabel = (event: AuditEvent): string => {
  if (event.actorType === "USER") return event.actorId ?? "A user";
  return event.actorType === "AGENT" ? "Agent" : "System";
};

const count = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;

const str = (event: AuditEvent, key: string): string | undefined => {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const num = (event: AuditEvent, key: string): number | undefined => {
  const value = event.metadata?.[key];
  return typeof value === "number" ? value : undefined;
};

const strList = (event: AuditEvent, key: string): readonly string[] | undefined => {
  const value = event.metadata?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
};

const humanizeAction = (action: string): string => action.replace(/_/gu, " ").toLowerCase();

/**
 * DESIGN.md §7's fixed vocabulary of audit lines
 * (CHANGE_REQUEST_SUBMITTED, ANALYSIS_REQUESTED, ANALYSIS_COMPLETED,
 * PROPOSAL_CREATED, PROPOSAL_APPROVED/REJECTED, PROPOSAL_APPLIED,
 * PROPOSAL_VERIFIED, plus the two failure variants the same use cases can
 * emit). Anything else — none exists in this codebase today — still
 * renders, humanized, rather than showing a blank line or a raw code.
 */
export const describeAuditEvent = (event: AuditEvent): string => {
  const actor = actorLabel(event);
  switch (event.action) {
    case "CHANGE_REQUEST_SUBMITTED": {
      const rawText = str(event, "rawText");
      return rawText === undefined
        ? `${actor} submitted a change.`
        : `${actor} reported: "${rawText}"`;
    }
    case "ANALYSIS_REQUESTED":
      return `${actor} requested impact analysis.`;
    case "ANALYSIS_COMPLETED": {
      const conflicts = num(event, "conflictCount") ?? 0;
      const affected = num(event, "affectedEntityCount") ?? 0;
      return conflicts === 0
        ? `${actor} found no conflicts (${count(affected, "entity", "entities")} affected).`
        : `${actor} found ${count(conflicts, "conflict")}, affecting ${count(affected, "entity", "entities")}.`;
    }
    case "PROPOSAL_CREATED": {
      const operations = num(event, "operationCount");
      const proposal = event.entityId ?? "a plan";
      return operations === undefined
        ? `${actor} proposed ${proposal}.`
        : `${actor} proposed ${proposal} (${count(operations, "operation")}).`;
    }
    case "PROPOSAL_APPROVED":
      return `${actor} approved ${event.entityId ?? "the proposal"}.`;
    case "PROPOSAL_REJECTED":
      return `${actor} rejected ${event.entityId ?? "the proposal"}.`;
    case "PROPOSAL_APPLIED": {
      const operations = num(event, "operationCount");
      return operations === undefined
        ? `${actor} applied the proposal.`
        : `${actor} applied ${count(operations, "operation")}.`;
    }
    case "PROPOSAL_APPLY_FAILED":
      return `${actor} could not apply ${event.entityId ?? "the proposal"}.`;
    case "PROPOSAL_VERIFIED":
      return `${actor} verified the change.`;
    case "PROPOSAL_VERIFICATION_FAILED": {
      const failed = strList(event, "failedChecks");
      return failed === undefined || failed.length === 0
        ? `${actor} verification failed.`
        : `${actor} verification failed: ${failed.join(", ")}.`;
    }
    default:
      return `${actor} ${humanizeAction(event.action)}.`;
  }
};

/** `2026-09-10T12:00:00.000Z`, `Asia/Manila` → `20:00`. Falls back to the browser's own zone without one. */
export const formatAuditTime = (occurredAt: string, timeZone?: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(occurredAt));
