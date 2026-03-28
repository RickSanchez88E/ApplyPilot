import { describe, it, expect, vi, beforeEach } from "vitest";
import { getApplyBackfillPolicySnapshot, buildResolveApplyPayload } from "../../domain/apply-discovery/dispatch.js";

describe("Apply Discovery Dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildResolveApplyPayload", () => {
    it("should return null if no applyUrl or sourceDescUrl is provided", () => {
      const payload = buildResolveApplyPayload({
        jobKey: "linkedin:123",
        source: "linkedin",
      });
      expect(payload).toBeNull();
    });

    it("should prioritize applyUrl over sourceDescUrl", () => {
      const payload = buildResolveApplyPayload({
        jobKey: "linkedin:123",
        source: "linkedin",
        applyUrl: "https://example.com/apply",
        sourceDescUrl: "https://linkedin.com/job/123",
      });
      expect(payload).toEqual({
        type: "resolve_apply",
        jobKey: "linkedin:123",
        source: "linkedin",
        applyUrl: "https://example.com/apply",
        sourceDescUrl: "https://linkedin.com/job/123",
      });
    });

    it("should default to sourceDescUrl if applyUrl is empty", () => {
      const payload = buildResolveApplyPayload({
        jobKey: "linkedin:123",
        source: "linkedin",
        applyUrl: "   ",
        sourceDescUrl: "https://linkedin.com/job/123",
      });
      expect(payload).toEqual({
        type: "resolve_apply",
        jobKey: "linkedin:123",
        source: "linkedin",
        applyUrl: "https://linkedin.com/job/123",
        sourceDescUrl: "https://linkedin.com/job/123",
      });
    });
  });

  describe("getApplyBackfillPolicySnapshot", () => {
    it("should correctly combine defaults and env rules", () => {
      process.env.APPLY_LOGIN_READY_SOURCES = "linkedin,reed";
      const policy = getApplyBackfillPolicySnapshot();
      expect(policy.loginGatedStatuses).toContain("requires_login");
      expect(policy.loginRequiredSources).toContain("linkedin");
      expect(policy.loginReadySources).toEqual(["linkedin", "reed"]);
      process.env.APPLY_LOGIN_READY_SOURCES = undefined;
    });
  });
});
