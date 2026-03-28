import { describe, expect, it } from "vitest";
import { shouldSnapshot } from "../../domain/dedup/snapshot-policy.js";

describe("shouldSnapshot", () => {
  it("returns true when hashes differ", () => {
    expect(shouldSnapshot("aaa", "bbb")).toBe(true);
  });

  it("returns false when hashes match", () => {
    expect(shouldSnapshot("same", "same")).toBe(false);
  });
});
