import { describe, expect, it } from "vitest";
import { canTransition, assertTransition } from "../../domain/job-lifecycle/transitions.js";
import type { JobAvailabilityStatus } from "../../domain/job-lifecycle/job-status.js";

describe("canTransition", () => {
  const allowed: [JobAvailabilityStatus, JobAvailabilityStatus][] = [
    ["active", "suspected_expired"],
    ["active", "fetch_failed"],
    ["active", "blocked"],
    ["suspected_expired", "active"],
    ["suspected_expired", "expired"],
    ["expired", "active"],
    ["fetch_failed", "active"],
    ["fetch_failed", "suspected_expired"],
    ["fetch_failed", "blocked"],
    ["blocked", "active"],
    ["blocked", "fetch_failed"],
  ];

  for (const [from, to] of allowed) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  const forbidden: [JobAvailabilityStatus, JobAvailabilityStatus][] = [
    ["active", "expired"],
    ["expired", "suspected_expired"],
    ["expired", "blocked"],
    ["blocked", "expired"],
    ["blocked", "suspected_expired"],
    ["suspected_expired", "blocked"],
    ["suspected_expired", "fetch_failed"],
  ];

  for (const [from, to] of forbidden) {
    it(`forbids ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(false);
    });
  }

  it("allows same-state (no-op)", () => {
    expect(canTransition("active", "active")).toBe(true);
    expect(canTransition("blocked", "blocked")).toBe(true);
  });
});

describe("assertTransition", () => {
  it("throws on invalid transition", () => {
    expect(() => assertTransition("active", "expired")).toThrow("Invalid job status transition");
  });

  it("does not throw on valid transition", () => {
    expect(() => assertTransition("active", "suspected_expired")).not.toThrow();
  });
});
