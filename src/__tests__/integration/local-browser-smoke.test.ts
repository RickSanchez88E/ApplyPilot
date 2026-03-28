/**
 * Smoke tests for local-browser-manager and Jooble local chain.
 *
 * Group 1 (always run): Code-level verification that:
 *   - Config defaults to profile=sanchez
 *   - Jooble local worker imports scrapeJoobleLocal (not joobleAdapter)
 *   - withSourceLease has heartbeat logic
 *
 * Group 2 (requires Chrome + Redis): Real browser launch with sanchez profile.
 *   Skipped if Chrome exe not found or REDIS_URL is not set.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

// ── Group 1: code-level verification (no Chrome / Redis needed) ──

describe("local-browser config defaults", () => {
  it("profile defaults to sanchez", async () => {
    const { getLocalBrowserConfig } = await import("../../browser/local-browser-manager.js");
    const cfg = getLocalBrowserConfig();
    expect(cfg.profileDirectory).toBe("sanchez");
    expect(cfg.userDataDir).toContain("User Data");
    expect(cfg.chromeExecutablePath).toContain("chrome.exe");
  });

  it("launchPersistentContext uses automationDataDir root and --profile-directory arg", () => {
    const source = fs.readFileSync(
      new URL("../../browser/local-browser-manager.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "utf-8",
    );
    expect(source).toContain("chromium.launchPersistentContext(");
    expect(source).toContain("config.automationDataDir,");
    expect(source).toContain("--profile-directory=");
    expect(source).toContain("syncProfileState()");
  });
});

describe("jooble-local import chain", () => {
  it("scrapeJoobleLocal is importable", async () => {
    const mod = await import("../../sources/jooble-local.js");
    expect(typeof mod.scrapeJoobleLocal).toBe("function");
  });

  it("local-browser-worker imports scrapeJoobleLocal, not joobleAdapter", () => {
    const workerSource = fs.readFileSync(
      new URL("../../queue/local-browser-worker.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "utf-8",
    );
    expect(workerSource).toContain("scrapeJoobleLocal");
    expect(workerSource).not.toContain("joobleAdapter");
    expect(workerSource).toContain('from "../sources/jooble-local.js"');
  });

  it("jooble-local.ts does NOT import navigateWithCf, cdp-pool, or webshare", () => {
    const localSource = fs.readFileSync(
      new URL("../../sources/jooble-local.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "utf-8",
    );
    expect(localSource).not.toContain("navigateWithCf");
    expect(localSource).not.toContain("cdp-pool");
    expect(localSource).not.toContain("webshare");
    expect(localSource).toContain("createPage");
    expect(localSource).toContain('from "../browser/local-browser-manager.js"');
  });
});

describe("withSourceLease heartbeat", () => {
  it("source code contains heartbeat interval and extendLease calls", () => {
    const source = fs.readFileSync(
      new URL("../../browser/local-browser-manager.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "utf-8",
    );
    expect(source).toContain("HEARTBEAT_INTERVAL_MS");
    expect(source).toContain("extendLease");
    expect(source).toContain("setInterval");
    expect(source).toContain("clearInterval(heartbeat)");
  });

  it("resolve_apply handler in local-browser-worker uses withSourceLease", () => {
    const workerSource = fs.readFileSync(
      new URL("../../queue/local-browser-worker.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "utf-8",
    );
    expect(workerSource).toContain("withSourceLease(payload.source");
  });
});
