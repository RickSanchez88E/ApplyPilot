import { describe, expect, it } from "vitest";
import { identityHash, payloadHash } from "../../domain/dedup/content-hash.js";

describe("identityHash", () => {
  it("normalizes whitespace and case", () => {
    const a = identityHash("  Acme Corp  ", "Senior  Engineer");
    const b = identityHash("acme corp", "senior engineer");
    expect(a).toBe(b);
  });

  it("different company → different hash", () => {
    const a = identityHash("Acme", "Engineer");
    const b = identityHash("Globex", "Engineer");
    expect(a).not.toBe(b);
  });

  it("different title → different hash", () => {
    const a = identityHash("Acme", "Frontend Engineer");
    const b = identityHash("Acme", "Backend Engineer");
    expect(a).not.toBe(b);
  });
});

describe("payloadHash", () => {
  it("includes JD content in hash", () => {
    const a = payloadHash("Acme", "Engineer", "Build amazing things");
    const b = payloadHash("Acme", "Engineer", "Build terrible things");
    expect(a).not.toBe(b);
  });

  it("includes location when provided", () => {
    const a = payloadHash("Acme", "Engineer", "JD text", "London");
    const b = payloadHash("Acme", "Engineer", "JD text", "Berlin");
    expect(a).not.toBe(b);
  });

  it("is deterministic", () => {
    const a = payloadHash("Acme", "Engineer", "JD", "London");
    const b = payloadHash("Acme", "Engineer", "JD", "London");
    expect(a).toBe(b);
  });

  it("truncates JD to 2000 chars for stability", () => {
    const longJd = "x".repeat(5000);
    const a = payloadHash("Acme", "Eng", longJd);
    const slicedJd = "x".repeat(2000) + "y".repeat(3000);
    const b = payloadHash("Acme", "Eng", slicedJd);
    expect(a).toBe(b);
  });
});
