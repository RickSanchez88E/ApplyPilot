/**
 * Tests for resolveMaxAgeDays — mapping timeFilter strings to day counts.
 */
import { describe, expect, it } from "vitest";
import { resolveMaxAgeDays } from "../../queue/general-worker.js";

describe("resolveMaxAgeDays", () => {
  it("r86400 → 1 day", () => {
    expect(resolveMaxAgeDays("r86400")).toBe(1);
  });

  it("r604800 → 7 days", () => {
    expect(resolveMaxAgeDays("r604800")).toBe(7);
  });

  it("r2592000 → 30 days", () => {
    expect(resolveMaxAgeDays("r2592000")).toBe(30);
  });

  it("undefined → undefined", () => {
    expect(resolveMaxAgeDays(undefined)).toBeUndefined();
  });

  it("empty string → undefined", () => {
    expect(resolveMaxAgeDays("")).toBeUndefined();
  });

  it("numeric string fallback ('14' → 14)", () => {
    expect(resolveMaxAgeDays("14")).toBe(14);
  });

  it("invalid string → undefined (not NaN)", () => {
    expect(resolveMaxAgeDays("abc")).toBeUndefined();
  });

  it("negative number string → undefined", () => {
    expect(resolveMaxAgeDays("-5")).toBeUndefined();
  });

  it("zero string → undefined", () => {
    expect(resolveMaxAgeDays("0")).toBeUndefined();
  });
});
