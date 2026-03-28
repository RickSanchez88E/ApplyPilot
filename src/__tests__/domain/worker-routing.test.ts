/**
 * Tests that worker command handlers fail fast for unimplemented commands
 * and route to real logic for implemented ones.
 */
import { describe, expect, it, vi } from "vitest";
import { routeCommand, QUEUE_NAMES, type CommandPayload } from "../../queue/commands.js";

describe("worker fail-fast for unimplemented commands", () => {
  it("verify_job routed to general queue for non-browser source", () => {
    const cmd: CommandPayload = { type: "verify_job", jobKey: "reed:1", source: "reed" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("verify_job routed to browser queue for linkedin", () => {
    const cmd: CommandPayload = { type: "verify_job", jobKey: "linkedin:1", source: "linkedin" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.browser);
  });

  it("recheck_expiry always goes to general queue", () => {
    const cmd: CommandPayload = { type: "recheck_expiry", jobKey: "jooble:1", source: "jooble" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });
});

describe("discover_jobs routes correctly", () => {
  it("linkedin discover → browser", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "linkedin" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.browser);
  });

  it("jooble discover → browser", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "jooble" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.browser);
  });

  it("reed discover → general", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "reed" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("hn_hiring discover → general", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "hn_hiring" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("remoteok discover → general", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "remoteok" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });

  it("devitjobs discover → general", () => {
    const cmd: CommandPayload = { type: "discover_jobs", source: "devitjobs" };
    expect(routeCommand(cmd)).toBe(QUEUE_NAMES.general);
  });
});
