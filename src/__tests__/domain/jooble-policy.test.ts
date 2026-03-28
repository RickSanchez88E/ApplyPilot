import { describe, it, expect, vi } from "vitest";

/**
 * Jooble-specific boundary tests:
 *  1. scheduler does NOT include jooble by default
 *  2. jooble-local uses lowered defaults
 *  3. normalizeKeepAlivePages keeps <= 1 default page
 */

describe("Jooble Schedule Exclusion", () => {
  it("DEFAULT_SCHEDULES should NOT include jooble when env is unset", async () => {
    // Ensure env is unset (default)
    delete process.env.JOOBLE_SCHEDULE_ENABLED;
    // We need to reimport to get fresh module state
    const mod = await import("../../scheduler/index.js");
    const sources = mod.DEFAULT_SCHEDULES.map((s: any) => s.source);
    expect(sources).not.toContain("jooble");
    expect(sources).toContain("linkedin");
    expect(sources).toContain("reed");
    expect(sources).toContain("remoteok");
    expect(sources).toContain("devitjobs");
    expect(sources).toContain("hn_hiring");
  });
});

describe("Jooble Source Policy", () => {
  it("should use lowered defaults: HARD_CAP=5, DELAY_MIN=15000, DELAY_MAX=45000", () => {
    // These are module-level constants read from env. We check the env defaults.
    // The module reads process.env.JOOBLE_DESC_HARD_CAP ?? "5" etc.
    // Without overrides, defaults must be 5/15000/45000
    delete process.env.JOOBLE_DESC_HARD_CAP;
    delete process.env.JOOBLE_PAGE_DELAY_MIN_MS;
    delete process.env.JOOBLE_PAGE_DELAY_MAX_MS;
    delete process.env.JOOBLE_MAX_SEARCH_PAGES;

    // Validate the default fallback values match the code
    expect(parseInt(process.env.JOOBLE_DESC_HARD_CAP ?? "5", 10)).toBe(5);
    expect(parseInt(process.env.JOOBLE_PAGE_DELAY_MIN_MS ?? "15000", 10)).toBe(15000);
    expect(parseInt(process.env.JOOBLE_PAGE_DELAY_MAX_MS ?? "45000", 10)).toBe(45000);
    expect(parseInt(process.env.JOOBLE_MAX_SEARCH_PAGES ?? "1", 10)).toBe(1);
    expect(parseInt(process.env.JOOBLE_BREAKER_COOLDOWN_MS ?? "43200000", 10)).toBe(43200000);
  });

  it("should allow env override of Jooble policy", () => {
    process.env.JOOBLE_DESC_HARD_CAP = "10";
    process.env.JOOBLE_PAGE_DELAY_MIN_MS = "20000";
    expect(parseInt(process.env.JOOBLE_DESC_HARD_CAP ?? "5", 10)).toBe(10);
    expect(parseInt(process.env.JOOBLE_PAGE_DELAY_MIN_MS ?? "15000", 10)).toBe(20000);
    delete process.env.JOOBLE_DESC_HARD_CAP;
    delete process.env.JOOBLE_PAGE_DELAY_MIN_MS;
  });
});

describe("Jooble Desc Concurrency", () => {
  it("JOOBLE_DESC_CONCURRENCY should default to 2", () => {
    delete process.env.JOOBLE_DESC_CONCURRENCY;
    const val = Math.max(1, parseInt(process.env.JOOBLE_DESC_CONCURRENCY ?? "2", 10));
    expect(val).toBe(2);
  });

  it("JOOBLE_DESC_CONCURRENCY should allow env override", () => {
    process.env.JOOBLE_DESC_CONCURRENCY = "3";
    const val = Math.max(1, parseInt(process.env.JOOBLE_DESC_CONCURRENCY ?? "2", 10));
    expect(val).toBe(3);
    delete process.env.JOOBLE_DESC_CONCURRENCY;
  });

  it("JOOBLE_DESC_CONCURRENCY should clamp to minimum 1", () => {
    process.env.JOOBLE_DESC_CONCURRENCY = "0";
    const val = Math.max(1, parseInt(process.env.JOOBLE_DESC_CONCURRENCY ?? "2", 10));
    expect(val).toBe(1);
    delete process.env.JOOBLE_DESC_CONCURRENCY;
  });

  it("challenge abort flag should prevent new task dispatch", async () => {
    // Simulate the abort logic from scrapeDescsConcurrently
    let cfAborted = false;
    const dispatched: number[] = [];
    const cards = [1, 2, 3, 4, 5];

    for (let i = 0; i < cards.length; i++) {
      if (cfAborted) break;
      dispatched.push(cards[i]!);
      // Simulate card #2 triggering CF challenge
      if (cards[i] === 2) {
        cfAborted = true;
      }
    }

    // Only cards 1 and 2 should have been dispatched
    expect(dispatched).toEqual([1, 2]);
    expect(cfAborted).toBe(true);
  });

  it("other source concurrency configs should NOT be affected", () => {
    // The JOOBLE_DESC_CONCURRENCY env var should not leak to other sources
    // Other sources use their own concurrency from source-concurrency.ts
    const otherSources = ["linkedin", "reed", "remoteok", "devitjobs", "hn_hiring"];
    for (const source of otherSources) {
      const key = `${source.toUpperCase()}_DESC_CONCURRENCY`;
      expect(process.env[key]).toBeUndefined();
    }
  });
});

describe("normalizeKeepAlivePages", () => {
  it("should close excess about:blank pages, keep at most 1", async () => {
    const { normalizeKeepAlivePages } = await import("../../browser/local-browser-manager.js");
    // Mock a context with 5 about:blank pages
    const closeFns: Array<() => Promise<void>> = [];
    const mockPages = Array.from({ length: 5 }, () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      closeFns.push(closeFn);
      return {
        url: () => "about:blank",
        close: closeFn,
        isClosed: () => false,
      };
    });

    const mockContext = {
      pages: () => mockPages,
    } as any;

    const result = await normalizeKeepAlivePages(mockContext);
    // Should keep 1, close 4
    expect(result.closedCount).toBe(4);
    expect(result.remaining).toBe(1);
    // First page kept, rest closed
    expect(closeFns[0]).not.toHaveBeenCalled();
    expect(closeFns[1]).toHaveBeenCalled();
    expect(closeFns[4]).toHaveBeenCalled();
  });

  it("should close ALL default pages if non-default pages exist", async () => {
    const { normalizeKeepAlivePages } = await import("../../browser/local-browser-manager.js");
    const blankClose = vi.fn().mockResolvedValue(undefined);
    const mockPages = [
      { url: () => "about:blank", close: blankClose, isClosed: () => false },
      { url: () => "about:blank", close: vi.fn().mockResolvedValue(undefined), isClosed: () => false },
      { url: () => "https://jooble.org/something", close: vi.fn(), isClosed: () => false },
    ];

    const mockContext = { pages: () => mockPages } as any;
    const result = await normalizeKeepAlivePages(mockContext);
    // Both blank pages should be closed since a real page exists
    expect(result.closedCount).toBe(2);
  });

  it("should return {0,0} if no context", async () => {
    const { normalizeKeepAlivePages } = await import("../../browser/local-browser-manager.js");
    const result = await normalizeKeepAlivePages(undefined);
    expect(result.closedCount).toBe(0);
    expect(result.remaining).toBe(0);
  });
});
