import { describe, expect, it } from "vitest";

import { agentJobEventSchema, jobEnvelopeSchema, jobStageSchema } from "../src/job";
import { toolErrorSchema } from "../src/errors";

describe("job stages", () => {
  it("covers the pipeline the UI renders, in order", () => {
    expect(jobStageSchema.options).toEqual([
      "received",
      "resolving",
      "analyzing",
      "simulating",
      "validating",
      "awaiting_approval",
      "applying",
      "verifying",
      "completed",
      "failed",
    ]);
  });

  it("rejects a stage that would let a job skip approval", () => {
    expect(jobStageSchema.safeParse("auto_applying").success).toBe(false);
  });
});

describe("agentJobEventSchema", () => {
  const base = {
    jobId: "JOB-1",
    productionId: "PROD-DEMO",
    correlationId: "corr-001",
    stage: "analyzing",
    status: "STARTED",
    occurredAt: "2026-09-10T11:03:05.000Z",
  };

  it("accepts a stage transition without a message", () => {
    expect(agentJobEventSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an event missing the correlation ID that ties it to a request", () => {
    const { correlationId: _omitted, ...withoutCorrelationId } = base;
    expect(agentJobEventSchema.safeParse(withoutCorrelationId).success).toBe(false);
  });
});

describe("jobEnvelopeSchema", () => {
  const base = {
    id: "JOB-1",
    type: "APPLY_PROPOSAL",
    productionId: "PROD-DEMO",
    correlationId: "corr-001",
    idempotencyKey: "apply-P-104-v12",
    attempt: 1,
    payload: { proposalId: "P-104" },
  };

  it("accepts a first delivery", () => {
    expect(jobEnvelopeSchema.safeParse(base).success).toBe(true);
  });

  it("rejects attempt zero, since a delivered message has been attempted at least once", () => {
    expect(jobEnvelopeSchema.safeParse({ ...base, attempt: 0 }).success).toBe(false);
  });

  it("requires an idempotency key so a retry cannot duplicate the work", () => {
    const { idempotencyKey: _omitted, ...withoutKey } = base;
    expect(jobEnvelopeSchema.safeParse(withoutKey).success).toBe(false);
  });
});

describe("toolErrorSchema", () => {
  it("accepts an error that tells the caller what to do next", () => {
    expect(
      toolErrorSchema.safeParse({
        code: "PRODUCTION_VERSION_MISMATCH",
        message: "Proposal P-104 was simulated against version 12 but current version is 13.",
        expected: "12",
        actual: "13",
        nextStep: "Reload production state and re-run simulation before requesting approval.",
      }).success,
    ).toBe(true);
  });

  it("rejects an error code outside the documented set", () => {
    expect(
      toolErrorSchema.safeParse({ code: "OOPS", message: "Something went wrong." }).success,
    ).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(toolErrorSchema.safeParse({ code: "INTERNAL_ERROR", message: "" }).success).toBe(false);
  });
});
