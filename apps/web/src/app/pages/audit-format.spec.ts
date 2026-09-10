import { describe, expect, it } from "vitest";

import type { AuditEvent } from "@pca/contracts";

import { describeAuditEvent, formatAuditTime } from "./audit-format";

const T0 = "2026-09-10T12:00:00.000Z";

const event = (overrides: Partial<AuditEvent>): AuditEvent => ({
  id: "AE-1",
  productionId: "PROD-DEMO",
  actorType: "SYSTEM",
  action: "ANALYSIS_REQUESTED",
  createdAt: T0,
  ...overrides,
});

describe("describeAuditEvent", () => {
  it("quotes the user's own reported text (DESIGN.md §7: 'User reported ...')", () => {
    const text = describeAuditEvent(
      event({
        actorType: "USER",
        actorId: "coordinator@example.test",
        action: "CHANGE_REQUEST_SUBMITTED",
        metadata: { rawText: "Sarah cannot shoot Friday." },
      }),
    );
    expect(text).toBe('coordinator@example.test reported: "Sarah cannot shoot Friday."');
  });

  it("names the agent requesting analysis", () => {
    expect(describeAuditEvent(event({ actorType: "AGENT", action: "ANALYSIS_REQUESTED" }))).toBe(
      "Agent requested impact analysis.",
    );
  });

  it("reports the conflict count found", () => {
    const text = describeAuditEvent(
      event({
        action: "ANALYSIS_COMPLETED",
        metadata: { conflictCount: 2, affectedEntityCount: 3 },
      }),
    );
    expect(text).toBe("System found 2 conflicts, affecting 3 entities.");
  });

  it("reports no conflicts found, without saying '0 conflicts'", () => {
    const text = describeAuditEvent(
      event({
        action: "ANALYSIS_COMPLETED",
        metadata: { conflictCount: 0, affectedEntityCount: 1 },
      }),
    );
    expect(text).toBe("System found no conflicts (1 entity affected).");
  });

  it("names the agent's proposal and its operation count (DESIGN.md §7: 'Agent proposed P-104')", () => {
    const text = describeAuditEvent(
      event({
        actorType: "AGENT",
        action: "PROPOSAL_CREATED",
        entityId: "P-104",
        metadata: { operationCount: 4 },
      }),
    );
    expect(text).toBe("Agent proposed P-104 (4 operations).");
  });

  it("names who approved a proposal (DESIGN.md §7: 'Jinho approved P-104')", () => {
    const text = describeAuditEvent(
      event({
        actorType: "USER",
        actorId: "jinho@example.test",
        action: "PROPOSAL_APPROVED",
        entityId: "P-104",
      }),
    );
    expect(text).toBe("jinho@example.test approved P-104.");
  });

  it("names who rejected a proposal", () => {
    const text = describeAuditEvent(
      event({
        actorType: "USER",
        actorId: "jinho@example.test",
        action: "PROPOSAL_REJECTED",
        entityId: "P-104",
      }),
    );
    expect(text).toBe("jinho@example.test rejected P-104.");
  });

  it("reports the operations applied (DESIGN.md §7: 'System applied 4 operations')", () => {
    const text = describeAuditEvent(
      event({ action: "PROPOSAL_APPLIED", metadata: { operationCount: 4 } }),
    );
    expect(text).toBe("System applied 4 operations.");
  });

  it("reports an apply failure without dumping raw conflict data", () => {
    const text = describeAuditEvent(event({ action: "PROPOSAL_APPLY_FAILED", entityId: "P-104" }));
    expect(text).toBe("System could not apply P-104.");
  });

  it("reports a successful verification (DESIGN.md §7: 'System verified schedule')", () => {
    expect(describeAuditEvent(event({ action: "PROPOSAL_VERIFIED" }))).toBe(
      "System verified the change.",
    );
  });

  it("names the failed checks on a verification failure", () => {
    const text = describeAuditEvent(
      event({
        action: "PROPOSAL_VERIFICATION_FAILED",
        metadata: { failedChecks: ["Operations were recorded"] },
      }),
    );
    expect(text).toBe("System verification failed: Operations were recorded.");
  });

  it("falls back to a humanized, non-blank line for an action it does not otherwise know", () => {
    expect(describeAuditEvent(event({ action: "SOMETHING_NEW" }))).toBe("System something new.");
  });

  it("uses 'A user' when a USER event carries no actor ID", () => {
    expect(describeAuditEvent(event({ actorType: "USER", action: "PROPOSAL_APPROVED" }))).toBe(
      "A user approved the proposal.",
    );
  });
});

describe("formatAuditTime", () => {
  it("renders HH:MM in the given timezone", () => {
    expect(formatAuditTime(T0, "Asia/Manila")).toBe("20:00");
  });

  it("renders HH:MM in a different timezone", () => {
    expect(formatAuditTime(T0, "UTC")).toBe("12:00");
  });
});
