import { describe, expect, it } from "vitest";
import { getStrategyForSource } from "../../domain/expiry/expiry-judge.js";

describe("getStrategyForSource", () => {
  it("returns ReedExpiryStrategy for reed", () => {
    expect(getStrategyForSource("reed").source).toBe("reed");
  });

  it("returns JoobleExpiryStrategy for jooble", () => {
    expect(getStrategyForSource("jooble").source).toBe("jooble");
  });

  it("returns LinkedInExpiryStrategy for linkedin", () => {
    expect(getStrategyForSource("linkedin").source).toBe("linkedin");
  });

  it("returns GenericFeedExpiryStrategy for hn_hiring", () => {
    expect(getStrategyForSource("hn_hiring").source).toBe("generic");
  });

  it("returns GenericFeedExpiryStrategy for remoteok", () => {
    expect(getStrategyForSource("remoteok").source).toBe("generic");
  });

  it("returns GenericFeedExpiryStrategy for devitjobs", () => {
    expect(getStrategyForSource("devitjobs").source).toBe("generic");
  });

  it("falls back to GenericFeedExpiryStrategy for unknown source", () => {
    expect(getStrategyForSource("unknown_source").source).toBe("generic");
  });
});
