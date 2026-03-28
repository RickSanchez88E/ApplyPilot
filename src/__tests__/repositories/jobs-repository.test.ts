import { describe, expect, it, vi, beforeEach } from "vitest";

const queryMock = vi.fn();

vi.mock("../../db/client.js", () => ({
  query: queryMock,
}));

describe("jobs-repository", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  describe("upsertJob", () => {
    it("returns isNew=true and previousHash=null for new inserts", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ is_new: true, prev_hash: null }],
        rowCount: 1,
      });
      const { upsertJob } = await import("../../repositories/jobs-repository.js");
      const result = await upsertJob({
        jobKey: "reed:123",
        source: "reed",
        title: "Engineer",
        company: "Acme",
        contentHash: "hash_a",
        jdRaw: "JD text",
      });
      expect(result.isNew).toBe(true);
      expect(result.previousHash).toBeNull();
    });

    it("returns isNew=false and the OLD hash for updates (CTE snapshot)", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ is_new: false, prev_hash: "old_hash_before_update" }],
        rowCount: 1,
      });
      const { upsertJob } = await import("../../repositories/jobs-repository.js");
      const result = await upsertJob({
        jobKey: "reed:123",
        source: "reed",
        title: "Engineer v2",
        company: "Acme",
        contentHash: "new_hash",
        jdRaw: "Updated JD",
      });
      expect(result.isNew).toBe(false);
      expect(result.previousHash).toBe("old_hash_before_update");
    });

    it("uses CTE 'WITH old AS' to capture pre-update hash", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ is_new: false, prev_hash: "xxx" }],
        rowCount: 1,
      });
      const { upsertJob } = await import("../../repositories/jobs-repository.js");
      await upsertJob({
        jobKey: "reed:1",
        source: "reed",
        title: "T",
        company: "C",
        contentHash: "h",
        jdRaw: "",
      });
      const sql: string = queryMock.mock.calls[0]![0];
      expect(sql).toContain("WITH old AS");
      expect(sql).toContain("SELECT content_hash FROM old");
    });
  });

  describe("transitionStatus", () => {
    it("returns updated=true when row matches", async () => {
      queryMock.mockResolvedValueOnce({ rowCount: 1 });
      const { transitionStatus } = await import("../../repositories/jobs-repository.js");
      const result = await transitionStatus("reed:1", "active", "suspected_expired");
      expect(result.updated).toBe(true);
    });

    it("returns updated=false when from-status does not match (no-op)", async () => {
      queryMock.mockResolvedValueOnce({ rowCount: 0 });
      const { transitionStatus } = await import("../../repositories/jobs-repository.js");
      const result = await transitionStatus("reed:1", "active", "suspected_expired");
      expect(result.updated).toBe(false);
    });

    it("throws on illegal transition", async () => {
      const { transitionStatus } = await import("../../repositories/jobs-repository.js");
      await expect(transitionStatus("reed:1", "active", "expired")).rejects.toThrow("Invalid job status transition");
    });

    it("returns updated=true for same-state no-op (from === to)", async () => {
      const { transitionStatus } = await import("../../repositories/jobs-repository.js");
      const result = await transitionStatus("reed:1", "active", "active");
      expect(result.updated).toBe(true);
      // No SQL issued for same-state
      expect(queryMock).not.toHaveBeenCalled();
    });
  });
});
