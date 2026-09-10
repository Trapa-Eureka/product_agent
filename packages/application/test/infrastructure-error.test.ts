import { describe, expect, it } from "vitest";

import { createMemoryStore } from "@pca/memory-store";
import { withFault, withRepositoryFault } from "@pca/test-support";

import { InfrastructureError, describeFailure, guardPort, guardRepositories } from "../src";

describe("InfrastructureError", () => {
  it("names the boundary, keeps the cause, and carries the correlation ID when attributed", () => {
    const cause = new Error("connection closed");
    const error = new InfrastructureError("mongo.productions.commit", cause);
    expect(error.message).toBe("mongo.productions.commit failed: connection closed");
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("INFRASTRUCTURE_FAILURE");
    const attributed = error.withCorrelation("corr-7");
    expect(attributed.message).toBe(
      "mongo.productions.commit failed: connection closed (correlation corr-7)",
    );
    expect(attributed.boundary).toBe("mongo.productions.commit");
  });

  it("describes any failure with the correlation ID for a report", () => {
    expect(describeFailure(new Error("disk full"), "corr-1")).toBe(
      "disk full (correlation corr-1)",
    );
    expect(describeFailure("odd", "corr-1")).toBe("odd (correlation corr-1)");
    expect(
      describeFailure(
        new InfrastructureError("file.proposals.save", new Error("EACCES")),
        "corr-2",
      ),
    ).toBe("file.proposals.save failed: EACCES (correlation corr-2)");
    expect(describeFailure(new Error("x"))).toBe("x");
  });
});

describe("guardPort / guardRepositories", () => {
  it("turns a rejected method into an InfrastructureError naming adapter, repository, and method", async () => {
    const store = withRepositoryFault(createMemoryStore(), "productions", "loadState", {
      error: new Error("socket hang up"),
    });
    const guarded = guardRepositories("memory", store);
    await expect(guarded.productions.loadState("PROD-DEMO")).rejects.toMatchObject({
      name: "InfrastructureError",
      boundary: "memory.productions.loadState",
      message: "memory.productions.loadState failed: socket hang up",
    });
  });

  it("wraps a synchronous throw too, and leaves values and non-function members alone", () => {
    const port = {
      label: "x",
      read: () => 42,
      explode: (): number => {
        throw new Error("boom");
      },
    };
    const guarded = guardPort("test.port", port);
    expect(guarded.label).toBe("x");
    expect(guarded.read()).toBe(42);
    expect(() => guarded.explode()).toThrow(InfrastructureError);
    expect(() => guarded.explode()).toThrow("test.port.explode failed: boom");
  });

  it("does not double-wrap an error that already names its boundary", async () => {
    const inner = guardPort("mongo.productions", {
      commit: () => Promise.reject(new Error("write conflict")),
    });
    const outer = guardPort("outer", inner);
    await expect(outer.commit()).rejects.toMatchObject({ boundary: "mongo.productions.commit" });
  });

  it("fault helpers fail the scripted number of times, then recover", async () => {
    const store = createMemoryStore();
    const faulty = withFault(store.auditEvents, "list", { error: new Error("flaky"), times: 2 });
    await expect(faulty.list("PROD-DEMO")).rejects.toThrow("flaky");
    await expect(faulty.list("PROD-DEMO")).rejects.toThrow("flaky");
    expect(await faulty.list("PROD-DEMO")).toEqual([]);
    expect(faulty.failures()).toBe(2);
  });
});
