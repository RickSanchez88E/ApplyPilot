import { describe, expect, it } from "vitest";
import { routeCommand, QUEUE_NAMES, type CommandPayload } from "../../queue/commands.js";

describe("routeCommand", () => {
  it("routes LinkedIn discover to browser queue", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "linkedin" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.browser);
  });

  it("routes Jooble discover to local-browser queue", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "jooble" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.localBrowser);
  });

  it("routes Reed discover to general queue", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "reed" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("routes HN hiring discover to general queue", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "hn_hiring" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("routes LinkedIn verify to browser queue", () => {
    const cmd: CommandPayload = { type: "verify_job", jobKey: "linkedin:123", source: "linkedin" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.browser);
  });

  it("routes Reed verify to general queue", () => {
    const cmd: CommandPayload = { type: "verify_job", jobKey: "reed:456", source: "reed" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("routes Jooble enrich to browser queue", () => {
    const cmd: CommandPayload = { type: "enrich_job", jobKey: "jooble:789", source: "jooble" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.browser);
  });

  it("routes recheck_expiry to general queue", () => {
    const cmd: CommandPayload = { type: "recheck_expiry", jobKey: "reed:123", source: "reed" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("routes refresh_source_cursor to general queue", () => {
    const cmd: CommandPayload = { type: "refresh_source_cursor", source: "devitjobs" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("routes resolve_apply to local-browser queue", () => {
    const cmd: CommandPayload = { type: "resolve_apply", jobKey: "reed:1", source: "reed", applyUrl: "https://example.com" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.localBrowser);
  });
});

describe("QUEUE_NAMES", () => {
  it("has general, browser, and localBrowser queues", () => {
    expect(QUEUE_NAMES.general).toBe("worker-general");
    expect(QUEUE_NAMES.browser).toBe("worker-browser");
    expect(QUEUE_NAMES.localBrowser).toBe("worker-local-browser");
  });
});
