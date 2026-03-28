import { describe, it, expect, vi, beforeEach } from "vitest";
import { canDispatch } from "../../scheduler/index.js";
import * as leaseObj from "../../scheduler/source-lease.js";
import * as breakerObj from "../../browser/circuit-breaker.js";

vi.mock("../../scheduler/source-lease.js", () => ({
  isLeaseHeld: vi.fn(),
}));

vi.mock("../../browser/circuit-breaker.js", () => ({
  isSourceInCooldown: vi.fn(),
  getBreakerState: vi.fn(),
}));

describe("Scheduler Dispatch Logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("canDispatch", () => {
    it("should return ok:true when no lease is held and not in cooldown", async () => {
      vi.mocked(leaseObj.isLeaseHeld).mockResolvedValue(null);
      vi.mocked(breakerObj.isSourceInCooldown).mockResolvedValue(false);

      const result = await canDispatch("linkedin");
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should return ok:false when lease is currently held", async () => {
      vi.mocked(leaseObj.isLeaseHeld).mockResolvedValue({
        source: "linkedin",
        holder: "worker-1",
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      });
      vi.mocked(breakerObj.isSourceInCooldown).mockResolvedValue(false);

      const result = await canDispatch("linkedin");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("lease held by worker-1");
    });

    it("should return ok:false when source is in cooldown", async () => {
      vi.mocked(leaseObj.isLeaseHeld).mockResolvedValue(null);
      vi.mocked(breakerObj.isSourceInCooldown).mockResolvedValue(true);
      vi.mocked(breakerObj.getBreakerState).mockResolvedValue({
        cooldownUntil: "2026-03-28T22:00:00.000Z",
        failures: 5,
      });

      const result = await canDispatch("linkedin");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("cooldown until 2026-03-28T22:00:00.000Z");
    });
  });
});
