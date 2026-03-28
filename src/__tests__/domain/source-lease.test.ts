import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireLease, releaseLease, isLeaseHeld, extendLease } from "../../scheduler/source-lease.js";
import { getRedisConnection } from "../../lib/redis.js";

vi.mock("../../lib/redis.js", () => ({
  getRedisConnection: vi.fn(),
}));

describe("Source Lease Domain", () => {
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    (getRedisConnection as any).mockReturnValue(mockRedis);
  });

  describe("acquireLease", () => {
    it("should acquire a new lease when none exists", async () => {
      mockRedis.get.mockResolvedValue(null);
      const lease = await acquireLease("linkedin", "worker-1", 1000);
      
      expect(lease).not.toBeNull();
      expect(lease?.source).toBe("linkedin");
      expect(lease?.holder).toBe("worker-1");
      expect(mockRedis.set).toHaveBeenCalledWith("lease:linkedin", expect.any(String), "PX", 1000);
    });

    it("should return null if another worker holds the active lease", async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        source: "linkedin",
        holder: "worker-2",
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      }));

      const lease = await acquireLease("linkedin", "worker-1", 1000);
      expect(lease).toBeNull();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it("should overwrite an expired lease held by another worker", async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        source: "linkedin",
        holder: "worker-2",
        expiresAt: new Date(Date.now() - 10000).toISOString(),
      }));

      const lease = await acquireLease("linkedin", "worker-1", 1000);
      expect(lease).not.toBeNull();
      expect(lease?.holder).toBe("worker-1");
      expect(mockRedis.set).toHaveBeenCalled();
    });
  });

  describe("releaseLease", () => {
    it("should release the lease if the requester is the current holder", async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        source: "linkedin",
        holder: "worker-1",
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      }));

      const result = await releaseLease("linkedin", "worker-1");
      expect(result).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith("lease:linkedin");
    });

    it("should fail to release if the requester is not the holder", async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        source: "linkedin",
        holder: "worker-2",
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      }));

      const result = await releaseLease("linkedin", "worker-1");
      expect(result).toBe(false);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });
});
