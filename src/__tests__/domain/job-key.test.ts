import { describe, expect, it } from "vitest";
import { buildJobKey, parseJobKey } from "../../domain/dedup/job-key.js";

describe("buildJobKey", () => {
  it("uses external_job_id when available", () => {
    const key = buildJobKey("reed", { externalJobId: "12345" });
    expect(key).toBe("reed:12345");
  });

  it("falls back to canonical_url hash", () => {
    const key = buildJobKey("jooble", { canonicalUrl: "https://jooble.org/desc/123" });
    expect(key).toMatch(/^jooble:url_[a-f0-9]{16}$/);
  });

  it("falls back to sourceUrl when no canonicalUrl", () => {
    const key = buildJobKey("devitjobs", { sourceUrl: "https://devitjobs.com/job/abc" });
    expect(key).toMatch(/^devitjobs:url_[a-f0-9]{16}$/);
  });

  it("falls back to linkedinUrl last", () => {
    const key = buildJobKey("linkedin", { linkedinUrl: "https://linkedin.com/jobs/view/999" });
    expect(key).toMatch(/^linkedin:url_[a-f0-9]{16}$/);
  });

  it("throws when no identifier at all", () => {
    expect(() => buildJobKey("reed", {})).toThrow("no ID or URL");
  });

  it("produces deterministic output for same input", () => {
    const a = buildJobKey("jooble", { canonicalUrl: "https://jooble.org/desc/42" });
    const b = buildJobKey("jooble", { canonicalUrl: "https://jooble.org/desc/42" });
    expect(a).toBe(b);
  });

  it("produces different keys for different URLs", () => {
    const a = buildJobKey("jooble", { canonicalUrl: "https://jooble.org/desc/1" });
    const b = buildJobKey("jooble", { canonicalUrl: "https://jooble.org/desc/2" });
    expect(a).not.toBe(b);
  });
});

describe("parseJobKey", () => {
  it("parses source:id format", () => {
    expect(parseJobKey("reed:12345")).toEqual({ source: "reed", identifier: "12345" });
  });

  it("parses url-hash format", () => {
    const parsed = parseJobKey("jooble:url_abcdef0123456789");
    expect(parsed.source).toBe("jooble");
    expect(parsed.identifier).toBe("url_abcdef0123456789");
  });

  it("throws on malformed key", () => {
    expect(() => parseJobKey("nocolon")).toThrow("Malformed");
  });
});
