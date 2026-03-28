/**
 * Tests that handleRecheckExpiry correctly maps transition results to crawl_run status.
 *
 * - no_change → completed
 * - migration success (updated=true) → completed
 * - migration expected but updated=false (status drift) → cancelled
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetJobByKey = vi.fn();
const mockTransitionStatus = vi.fn();
const mockIncrementMissingCount = vi.fn();
const mockJudgeExpiry = vi.fn();
const mockCreateCrawlRun = vi.fn();
const mockFinishCrawlRun = vi.fn();

vi.mock("../../repositories/jobs-repository.js", () => ({
  getJobByKey: (...args: unknown[]) => mockGetJobByKey(...args),
  transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  incrementMissingCount: (...args: unknown[]) => mockIncrementMissingCount(...args),
}));

vi.mock("../../domain/expiry/expiry-judge.js", () => ({
  judgeExpiry: (...args: unknown[]) => mockJudgeExpiry(...args),
}));

vi.mock("../../repositories/crawl-run-repository.js", () => ({
  createCrawlRun: (...args: unknown[]) => mockCreateCrawlRun(...args),
  finishCrawlRun: (...args: unknown[]) => mockFinishCrawlRun(...args),
}));

vi.mock("../../lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../lib/redis.js", () => ({
  getRedisConnection: () => ({}),
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn(),
}));

vi.mock("../../sources/orchestrator.js", () => ({
  ALL_ADAPTERS: [],
}));

vi.mock("../../ingest/dedup.js", () => ({
  dedupAndInsert: vi.fn(),
}));

describe("handleRecheckExpiry crawl_run status correctness", () => {
  const fakeJob = {
    job_key: "reed:123",
    source: "reed",
    apply_url: "https://reed.co.uk/jobs/123",
    canonical_url: "https://reed.co.uk/jobs/123",
    consecutive_missing_count: 0,
    job_status: "active",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByKey.mockResolvedValue(fakeJob);
    mockCreateCrawlRun.mockResolvedValue(1n);
    mockFinishCrawlRun.mockResolvedValue(undefined);
    mockIncrementMissingCount.mockResolvedValue(undefined);
  });

  it("no_change decision → completed with no_change evidence", async () => {
    mockJudgeExpiry.mockResolvedValue({ action: "no_change", reason: "page still live" });

    // Dynamically import to get the mocked version
    const mod = await import("../../queue/general-worker.js");
    // We need to call the internal handler — let's invoke processJob via the module
    // Since handleRecheckExpiry is not exported, we test via effect on mockFinishCrawlRun
    // by calling the exported resolveMaxAgeDays to verify module loads, then manually invoking.
    // Actually, we access the worker's processJob indirectly; let's create a simulated Job.

    // The handler is not directly exported, so we re-import and test indirectly.
    // We'll test the crawl run recording by checking finishCrawlRun calls.
    // For now, verify the module-level behavior by importing and testing the function path.

    // Since handleRecheckExpiry is a module-private function called by processJob,
    // and processJob is passed to BullMQ Worker constructor, we need to test through the mocks.
    // Let's just verify the logic by importing the module and trusting that mocks are wired.

    // Re-approach: import then call the processJob via constructing a fake BullMQ Job
    const { handleRecheckExpiryForTest } = await import("../../queue/general-worker.js");
    if (handleRecheckExpiryForTest) {
      await handleRecheckExpiryForTest({ jobKey: "reed:123", source: "reed", type: "recheck_expiry" });
    }

    expect(mockFinishCrawlRun).toHaveBeenCalledWith(
      1n,
      expect.objectContaining({
        status: "completed",
        evidenceSummary: expect.stringContaining("no_change"),
      }),
    );
  });

  it("transition success (updated=true) → completed", async () => {
    mockJudgeExpiry.mockResolvedValue({ action: "expired", reason: "404 returned" });
    mockTransitionStatus.mockResolvedValue({ updated: true });

    const { handleRecheckExpiryForTest } = await import("../../queue/general-worker.js");
    if (handleRecheckExpiryForTest) {
      await handleRecheckExpiryForTest({ jobKey: "reed:123", source: "reed", type: "recheck_expiry" });
    }

    expect(mockFinishCrawlRun).toHaveBeenCalledWith(
      1n,
      expect.objectContaining({
        status: "completed",
        evidenceSummary: expect.stringContaining("transitioned"),
      }),
    );
  });

  it("transition expected but updated=false → cancelled", async () => {
    mockJudgeExpiry.mockResolvedValue({ action: "expired", reason: "404 returned" });
    mockTransitionStatus.mockResolvedValue({ updated: false });

    const { handleRecheckExpiryForTest } = await import("../../queue/general-worker.js");
    if (handleRecheckExpiryForTest) {
      await handleRecheckExpiryForTest({ jobKey: "reed:123", source: "reed", type: "recheck_expiry" });
    }

    expect(mockFinishCrawlRun).toHaveBeenCalledWith(
      1n,
      expect.objectContaining({
        status: "cancelled",
        evidenceSummary: expect.stringContaining("transition_not_applied"),
      }),
    );
  });
});
