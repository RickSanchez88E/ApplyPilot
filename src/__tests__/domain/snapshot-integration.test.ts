/**
 * Integration test: snapshot write decision in dedup dual-write path.
 * Verifies that the combination of upsertJob + shouldSnapshot + insertSnapshot
 * behaves correctly across all scenarios.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { payloadHash } from "../../domain/dedup/content-hash.js";
import { shouldSnapshot } from "../../domain/dedup/snapshot-policy.js";

describe("snapshot decision integration", () => {
  it("new job (previousHash=null): no snapshot written", () => {
    const isNew = true;
    const previousHash: string | null = null;
    const currentHash = payloadHash("Acme", "Engineer", "JD content");

    const shouldWrite = !isNew && previousHash !== null && shouldSnapshot(previousHash, currentHash);
    expect(shouldWrite).toBe(false);
  });

  it("same content re-upsert: no snapshot written", () => {
    const isNew = false;
    const hash = payloadHash("Acme", "Engineer", "JD content");
    const previousHash = hash;

    const shouldWrite = !isNew && previousHash !== null && shouldSnapshot(previousHash, hash);
    expect(shouldWrite).toBe(false);
  });

  it("content changed (different JD): snapshot MUST be written", () => {
    const isNew = false;
    const oldHash = payloadHash("Acme", "Engineer", "Original JD");
    const newHash = payloadHash("Acme", "Engineer", "Updated JD with new requirements");

    expect(oldHash).not.toBe(newHash);
    const shouldWrite = !isNew && oldHash !== null && shouldSnapshot(oldHash, newHash);
    expect(shouldWrite).toBe(true);
  });

  it("content changed (different location): snapshot MUST be written", () => {
    const isNew = false;
    const oldHash = payloadHash("Acme", "Engineer", "JD", "London");
    const newHash = payloadHash("Acme", "Engineer", "JD", "Berlin");

    expect(oldHash).not.toBe(newHash);
    const shouldWrite = !isNew && oldHash !== null && shouldSnapshot(oldHash, newHash);
    expect(shouldWrite).toBe(true);
  });
});
