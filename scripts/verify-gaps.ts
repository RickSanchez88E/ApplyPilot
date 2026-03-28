/**
 * verify-gaps.ts — real verification for:
 *  1) forceResync deferred lifecycle
 *  2) Edge engine startup
 *  3) scheduler mutex while lease heartbeat is active
 *  4) stratified breaker behavior by failure type
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6380 npx tsx scripts/verify-gaps.ts
 */

import fs from "node:fs";
import path from "node:path";

const PASS = "PASS";
const FAIL = "FAIL";
let passCount = 0;
let failCount = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passCount++;
    console.log(`[${PASS}] ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failCount++;
    console.log(`[${FAIL}] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function verifyDeferredResync(): Promise<void> {
  console.log("\n=== GAP 1: forceResync deferred lifecycle ===");

  const {
    createPage,
    closeBrowser,
    forceResyncProfileNow,
    getLocalBrowserConfig,
    getProfileSyncStatus,
  } = await import("../src/browser/local-browser-manager.js");

  const cfg = getLocalBrowserConfig();
  const marker = path.join(cfg.automationDataDir, cfg.profileDirectory, ".synced");
  const before = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";

  const session = await createPage("__verify_resync__");
  const deferred = forceResyncProfileNow();

  check("forceResync while browser active returns pending=true", deferred.pending === true);
  check("forceResync while browser active returns lastAction=deferred", deferred.lastAction === "deferred");

  // Keep browser alive briefly to ensure deferred path is stable.
  await new Promise((resolve) => setTimeout(resolve, 500));

  await session.close();
  await closeBrowser();

  const afterStatus = getProfileSyncStatus();
  const after = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";

  check("deferred resync consumed after browser closes", afterStatus.pending === false);
  check("lastAction is immediate after deferred execution", afterStatus.lastAction === "immediate");
  check("marker refreshed after deferred execution", before !== after, `before=${before || "none"} after=${after || "none"}`);
}

async function verifyEdgeLaunch(): Promise<void> {
  console.log("\n=== GAP 2: Edge engine startup ===");

  const {
    updateLocalBrowserConfig,
    getLocalBrowserConfig,
    createPage,
    closeBrowser,
  } = await import("../src/browser/local-browser-manager.js");

  const original = getLocalBrowserConfig();
  const edgeExe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const edgeUserData = "C:\\Users\\rick\\AppData\\Local\\Microsoft\\Edge\\User Data";
  const edgeExists = fs.existsSync(edgeExe);

  check("Edge executable exists on host", edgeExists, edgeExe);
  if (!edgeExists) {
    // Restore and skip runtime launch checks.
    updateLocalBrowserConfig(original);
    return;
  }

  updateLocalBrowserConfig({
    engine: "edge",
    executablePath: edgeExe,
    userDataDir: edgeUserData,
    profileDirectory: "sanchez",
  });

  const session = await createPage("__verify_edge__");
  await session.page.goto("https://www.example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  const title = await session.page.title();
  await session.close();
  await closeBrowser();

  check("Edge mode can open page", title.includes("Example"), `title=${title}`);

  const current = getLocalBrowserConfig();
  check("engine switched to edge in runtime config", current.engine === "edge");

  // Restore original runtime settings for remaining checks.
  updateLocalBrowserConfig(original);
}

async function verifySchedulerMutexWithHeartbeat(): Promise<void> {
  console.log("\n=== GAP 3: scheduler mutex under heartbeat ===");

  const { withSourceLease, updateLocalBrowserConfig, getLocalBrowserConfig } = await import("../src/browser/local-browser-manager.js");
  const { isLeaseHeld } = await import("../src/scheduler/source-lease.js");
  const { canDispatch } = await import("../src/scheduler/index.js");

  const original = getLocalBrowserConfig();
  updateLocalBrowserConfig({ heartbeatIntervalMs: 400 });
  const source = "__verify_mutex__";
  const holder = "verify-gaps";
  const ttl = 4000;

  let startExpiry = "";
  let midExpiry = "";
  let canDispatchStart = true;
  let canDispatchMid = true;

  await withSourceLease(source, holder, async () => {
    const lease0 = await isLeaseHeld(source);
    const dispatch0 = await canDispatch(source);
    startExpiry = lease0?.expiresAt ?? "";
    canDispatchStart = dispatch0.ok;

    await new Promise((resolve) => setTimeout(resolve, 1700));

    const lease1 = await isLeaseHeld(source);
    const dispatch1 = await canDispatch(source);
    midExpiry = lease1?.expiresAt ?? "";
    canDispatchMid = dispatch1.ok;
  }, ttl);

  const dispatchAfter = await canDispatch(source);

  check("canDispatch=false at task start", canDispatchStart === false);
  check("canDispatch=false mid-task after heartbeat", canDispatchMid === false);
  check("canDispatch=true after release", dispatchAfter.ok === true);
  check("lease expiry advanced while task running", Boolean(startExpiry && midExpiry && midExpiry > startExpiry), `start=${startExpiry} mid=${midExpiry}`);

  updateLocalBrowserConfig(original);
}

async function verifyBreakerStratified(): Promise<void> {
  console.log("\n=== GAP 4: breaker stratified behavior ===");

  const mgr = await import("../src/browser/local-browser-manager.js");
  const breaker = await import("../src/browser/circuit-breaker.js");

  const severeSource = "__verify_breaker_severe__";
  const transientSource = "__verify_breaker_transient__";

  await breaker.forceResetBreaker(severeSource);
  await breaker.forceResetBreaker(transientSource);

  // Severe failure: immediate cooldown.
  await mgr.destroyOnBreaker(severeSource, "cf_block");
  const severeState = await breaker.getBreakerState(severeSource);
  check("cf_block triggers immediate cooldown", severeState.isOpen === true, `cooldownUntil=${severeState.cooldownUntil}`);

  // Transient failure: no immediate cooldown at first failure.
  await mgr.destroyOnBreaker(transientSource, "timeout");
  const transientState = await breaker.getBreakerState(transientSource);
  check("timeout records failure without immediate cooldown", transientState.isOpen === false, `failures=${transientState.consecutiveFailures}`);
  check("timeout increments failure counter", transientState.consecutiveFailures >= 1, `failures=${transientState.consecutiveFailures}`);

  const managerSource = fs.readFileSync(path.resolve("src/browser/local-browser-manager.ts"), "utf8");
  check("severe set includes authwall", managerSource.includes('"authwall"'));
  check("destroyOnBreaker uses both forceOpenBreaker and recordFailure", managerSource.includes("forceOpenBreaker") && managerSource.includes("recordFailure"));

  await breaker.forceResetBreaker(severeSource);
  await breaker.forceResetBreaker(transientSource);
}

async function main(): Promise<void> {
  try {
    await verifyDeferredResync();
  } catch (error) {
    failCount++;
    console.log(`[${FAIL}] GAP 1 crashed — ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await verifyEdgeLaunch();
  } catch (error) {
    failCount++;
    console.log(`[${FAIL}] GAP 2 crashed — ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await verifySchedulerMutexWithHeartbeat();
  } catch (error) {
    failCount++;
    console.log(`[${FAIL}] GAP 3 crashed — ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await verifyBreakerStratified();
  } catch (error) {
    failCount++;
    console.log(`[${FAIL}] GAP 4 crashed — ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\nRESULTS: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("verify-gaps crashed:", error);
  process.exit(2);
});
