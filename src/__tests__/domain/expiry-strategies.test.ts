import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AvailabilityEvidence, ExpiryJobContext } from "../../domain/expiry/types.js";

// Mock the HTTP evidence collector so strategies don't make real requests
vi.mock("../../domain/expiry/evidence-collector.js", () => ({
  collectHttpEvidence: vi.fn(),
}));

function makeJob(overrides: Partial<ExpiryJobContext> = {}): ExpiryJobContext {
  return {
    jobKey: "test:123",
    source: "reed",
    applyUrl: "https://www.reed.co.uk/jobs/123",
    canonicalUrl: null,
    consecutiveMissingCount: 0,
    currentStatus: "active",
    ...overrides,
  };
}

describe("ReedExpiryStrategy", () => {
  let ReedExpiryStrategy: typeof import("../../domain/expiry/strategies/reed-strategy.js").ReedExpiryStrategy;
  let collectHttpEvidence: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("../../domain/expiry/evidence-collector.js");
    collectHttpEvidence = mod.collectHttpEvidence as ReturnType<typeof vi.fn>;
    collectHttpEvidence.mockReset();
    const strategyMod = await import("../../domain/expiry/strategies/reed-strategy.js");
    ReedExpiryStrategy = strategyMod.ReedExpiryStrategy;
  });

  it("classifies 404 as expired", () => {
    const s = new ReedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 404 };
    expect(s.classify(evidence, makeJob())).toEqual({ action: "expired", reason: "HTTP 404" });
  });

  it("classifies 410 as expired", () => {
    const s = new ReedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 410 };
    expect(s.classify(evidence, makeJob())).toEqual({ action: "expired", reason: "HTTP 410" });
  });

  it("classifies page pattern match as expired", () => {
    const s = new ReedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200, pagePattern: "the job has expired" };
    expect(s.classify(evidence, makeJob()).action).toBe("expired");
  });

  it("classifies timeout as fetch_failed", () => {
    const s = new ReedExpiryStrategy();
    const evidence: AvailabilityEvidence = { isUnreachable: true, errorMessage: "timeout" };
    expect(s.classify(evidence, makeJob()).action).toBe("fetch_failed");
  });

  it("classifies 200 OK as active", () => {
    const s = new ReedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200 };
    expect(s.classify(evidence, makeJob()).action).toBe("active");
  });
});

describe("JoobleExpiryStrategy", () => {
  let JoobleExpiryStrategy: typeof import("../../domain/expiry/strategies/jooble-strategy.js").JoobleExpiryStrategy;

  beforeEach(async () => {
    const mod = await import("../../domain/expiry/strategies/jooble-strategy.js");
    JoobleExpiryStrategy = mod.JoobleExpiryStrategy;
  });

  it("classifies Cloudflare page as blocked, NOT expired", () => {
    const s = new JoobleExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 403, isBlocked: true, pagePattern: "cloudflare" };
    const decision = s.classify(evidence, makeJob({ source: "jooble" }));
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain("Cloudflare");
  });

  it("classifies captcha as blocked", () => {
    const s = new JoobleExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200, isBlocked: true, pagePattern: "captcha" };
    expect(s.classify(evidence, makeJob({ source: "jooble" })).action).toBe("blocked");
  });

  it("classifies 404 as expired", () => {
    const s = new JoobleExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 404 };
    expect(s.classify(evidence, makeJob({ source: "jooble" })).action).toBe("expired");
  });

  it("classifies 200 as active", () => {
    const s = new JoobleExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200 };
    expect(s.classify(evidence, makeJob({ source: "jooble" })).action).toBe("active");
  });
});

describe("LinkedInExpiryStrategy", () => {
  let LinkedInExpiryStrategy: typeof import("../../domain/expiry/strategies/linkedin-strategy.js").LinkedInExpiryStrategy;

  beforeEach(async () => {
    const mod = await import("../../domain/expiry/strategies/linkedin-strategy.js");
    LinkedInExpiryStrategy = mod.LinkedInExpiryStrategy;
  });

  it("classifies authwall evidence as blocked, NOT expired", () => {
    const s = new LinkedInExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 302, isBlocked: true, pagePattern: "login redirect" };
    const decision = s.classify(evidence, makeJob({ source: "linkedin" }));
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain("authwall");
  });

  it("classifies clean 404 as expired", () => {
    const s = new LinkedInExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 404 };
    expect(s.classify(evidence, makeJob({ source: "linkedin" })).action).toBe("expired");
  });

  it("classifies session expired text as blocked", () => {
    const s = new LinkedInExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200, isBlocked: true, pagePattern: "sign in" };
    expect(s.classify(evidence, makeJob({ source: "linkedin" })).action).toBe("blocked");
  });

  it("classifies 200 OK as active", () => {
    const s = new LinkedInExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200 };
    expect(s.classify(evidence, makeJob({ source: "linkedin" })).action).toBe("active");
  });
});

describe("GenericFeedExpiryStrategy", () => {
  let GenericFeedExpiryStrategy: typeof import("../../domain/expiry/strategies/generic-feed-strategy.js").GenericFeedExpiryStrategy;

  beforeEach(async () => {
    const mod = await import("../../domain/expiry/strategies/generic-feed-strategy.js");
    GenericFeedExpiryStrategy = mod.GenericFeedExpiryStrategy;
  });

  it("single missing → suspected_expired (not expired)", () => {
    const s = new GenericFeedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 404 };
    const decision = s.classify(evidence, makeJob({ source: "hn_hiring", consecutiveMissingCount: 1 }));
    expect(decision.action).toBe("suspected_expired");
  });

  it("3+ consecutive missing → expired", () => {
    const s = new GenericFeedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 404 };
    const decision = s.classify(evidence, makeJob({ source: "hn_hiring", consecutiveMissingCount: 3 }));
    expect(decision.action).toBe("expired");
  });

  it("list-only missing with count < 3 → suspected_expired", () => {
    const s = new GenericFeedExpiryStrategy();
    const evidence: AvailabilityEvidence = { meta: { listMissing: true } };
    const decision = s.classify(evidence, makeJob({ source: "remoteok", consecutiveMissingCount: 2 }));
    expect(decision.action).toBe("suspected_expired");
  });

  it("list-only missing with count ≥ 3 → expired", () => {
    const s = new GenericFeedExpiryStrategy();
    const evidence: AvailabilityEvidence = { meta: { listMissing: true } };
    const decision = s.classify(evidence, makeJob({ source: "remoteok", consecutiveMissingCount: 4 }));
    expect(decision.action).toBe("expired");
  });

  it("200 OK → active", () => {
    const s = new GenericFeedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 200 };
    expect(s.classify(evidence, makeJob({ source: "devitjobs" })).action).toBe("active");
  });

  it("blocked evidence → blocked", () => {
    const s = new GenericFeedExpiryStrategy();
    const evidence: AvailabilityEvidence = { httpStatus: 403, isBlocked: true, pagePattern: "captcha" };
    expect(s.classify(evidence, makeJob({ source: "devitjobs" })).action).toBe("blocked");
  });
});
