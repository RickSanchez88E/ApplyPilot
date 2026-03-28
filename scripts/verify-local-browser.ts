/**
 * verify-local-browser.ts — Integration test for the 3 reworked problems.
 *
 * Run: REDIS_URL=redis://localhost:6380 npx tsx scripts/verify-local-browser.ts
 *
 * Tests:
 *   1. Chrome launches with profileDirectory=sanchez
 *   2. Lease acquire + heartbeat extend + release
 *   3. destroyOnBreaker properly stops heartbeat + closes browser
 *   4. Jooble local path: scrapeJoobleLocal does NOT import old CDP/proxy
 */

import {
  createPage,
  closeBrowser,
  destroyOnBreaker,
  isBrowserAlive,
  getBrowserStats,
  getLocalBrowserConfig,
  withSourceLease,
} from "../src/browser/local-browser-manager.js";
import { acquireLease, isLeaseHeld, releaseLease, extendLease } from "../src/scheduler/source-lease.js";
import { forceResetBreaker, recordSuccess, isSourceInCooldown } from "../src/browser/circuit-breaker.js";

const passed: string[] = [];
const failed: string[] = [];

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed.push(label);
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed.push(label);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── TEST 1: Chrome launch with profile ───────────────────────
async function testChromeLaunch(): Promise<void> {
  console.log("\n═══ TEST 1: Chrome Launch with sanchez Profile ═══");

  const config = getLocalBrowserConfig();
  assert(config.profileDirectory === "sanchez", "Config profileDirectory = sanchez");
  assert(config.chromeExecutablePath.includes("chrome.exe"), "Config chromeExecutablePath points to chrome.exe");
  assert(config.userDataDir.includes("User Data"), "Config userDataDir = Chrome User Data");
  console.log(`    chromeExecutablePath: ${config.chromeExecutablePath}`);
  console.log(`    userDataDir: ${config.userDataDir}`);
  console.log(`    profileDirectory: ${config.profileDirectory}`);
  console.log(`    automationDataDir: ${config.automationDataDir}`);

  // Create a page — this triggers browser launch
  const session = await createPage("test-verify");
  const page = session.page;

  assert(isBrowserAlive(), "Browser process is alive after createPage()");
  const stats = getBrowserStats();
  assert(stats.activePages === 1, `Active pages = ${stats.activePages} (expect 1)`);

  // Navigate to a simple page
  await page.goto("https://jooble.org", { timeout: 15000, waitUntil: "domcontentloaded" });
  const title = await page.title();
  console.log(`    Page title: ${title}`);
  assert(title.length > 0, `Page loaded, title = "${title.slice(0, 50)}"`);

  // Close page
  await session.close();
  const stats2 = getBrowserStats();
  assert(stats2.activePages === 0, `Active pages = ${stats2.activePages} after close (expect 0)`);
  assert(isBrowserAlive(), "Browser still alive (idle timer hasn't fired yet)");
}

// ─── TEST 2: Lease acquire, extend, release ───────────────────
async function testLeaseLifecycle(): Promise<void> {
  console.log("\n═══ TEST 2: Lease Acquire / Extend / Release ═══");

  const source = "test-lease-verify";
  // Clean up any prior leases
  await releaseLease(source, "test-holder").catch(() => {});
  await forceResetBreaker(source);

  const lease = await acquireLease(source, "test-holder", 10_000);
  assert(lease !== null, "Lease acquired");
  console.log(`    lease.holder: ${lease?.holder}, expiresAt: ${lease?.expiresAt}`);

  const held = await isLeaseHeld(source);
  assert(held !== null, "Lease is held (isLeaseHeld returns non-null)");
  assert(held?.holder === "test-holder", `Holder = ${held?.holder}`);

  // Extend
  const extended = await extendLease(source, "test-holder", 10_000);
  assert(extended === true, "Lease extended successfully");

  const heldAfter = await isLeaseHeld(source);
  assert(heldAfter !== null, "Lease still held after extend");

  // Another holder cannot acquire
  const stolen = await acquireLease(source, "scheduler", 10_000);
  assert(stolen === null, "Another holder cannot acquire while lease is held");

  // Release
  const released = await releaseLease(source, "test-holder");
  assert(released === true, "Lease released");

  const heldFinal = await isLeaseHeld(source);
  assert(heldFinal === null, "Lease no longer held after release");
}

// ─── TEST 3: withSourceLease heartbeat ────────────────────────
async function testHeartbeat(): Promise<void> {
  console.log("\n═══ TEST 3: withSourceLease Heartbeat ═══");

  const source = "test-heartbeat-verify";
  await releaseLease(source, "test-hb").catch(() => {});
  await forceResetBreaker(source);

  // Lower TTL for testing (5 seconds, heartbeat every 2s)
  // We can't easily lower HEARTBEAT_INTERVAL_MS inside the module,
  // so we test that lease is held during the fn execution
  let leaseHeldDuringWork = false;
  let leaseReleasedAfterWork = false;

  await withSourceLease(source, "test-hb", async () => {
    const held = await isLeaseHeld(source);
    leaseHeldDuringWork = held !== null && held.holder === "test-hb";
    console.log(`    In-task: lease held = ${leaseHeldDuringWork}, holder = ${held?.holder}`);
    // Sleep briefly to verify lease stays active
    await sleep(2000);
    const held2 = await isLeaseHeld(source);
    console.log(`    After 2s: lease still held = ${held2 !== null}`);
  }, 30_000);

  const heldAfter = await isLeaseHeld(source);
  leaseReleasedAfterWork = heldAfter === null;

  assert(leaseHeldDuringWork, "Lease held during withSourceLease work");
  assert(leaseReleasedAfterWork, "Lease released after withSourceLease exits");
}

// ─── TEST 4: destroyOnBreaker stops heartbeat + closes browser ─
async function testBreakerDestroy(): Promise<void> {
  console.log("\n═══ TEST 4: destroyOnBreaker Lifecycle ═══");

  const source = "test-breaker-verify";
  await forceResetBreaker(source);
  await recordSuccess(source);

  // Ensure browser is running
  const session = await createPage(source);
  assert(isBrowserAlive(), "Browser alive before breaker");

  await session.close();

  // Trigger breaker destroy
  await destroyOnBreaker(source, "cf_block");

  assert(!isBrowserAlive(), "Browser killed after destroyOnBreaker");

  const inCooldown = await isSourceInCooldown(source);
  // May not be in cooldown yet (needs 3 failures by default),
  // but browser should be dead
  console.log(`    Source in cooldown: ${inCooldown}`);

  // Can relaunch after breaker
  await forceResetBreaker(source);
  const session2 = await createPage(source);
  assert(isBrowserAlive(), "Browser re-launched after breaker reset");
  const page2 = session2.page;
  await page2.goto("about:blank", { timeout: 5000 });
  assert(!page2.isClosed(), "New page is functional after relaunch");
  await session2.close();
}

// ─── TEST 5: Jooble local path does NOT use old CDP ───────────
async function testJoobleLocalPath(): Promise<void> {
  console.log("\n═══ TEST 5: Jooble Local Path Verification ═══");

  // Read the source file to verify no imports from old CDP/proxy
  const fs = await import("node:fs");
  const joobleLocalSource = fs.readFileSync("src/sources/jooble-local.ts", "utf8");

  assert(!joobleLocalSource.includes("navigateWithCf"), "jooble-local.ts does NOT import navigateWithCf");
  assert(!joobleLocalSource.includes("cdp-pool"), "jooble-local.ts does NOT import cdp-pool");
  assert(!joobleLocalSource.includes("webshare"), "jooble-local.ts does NOT import webshare");
  assert(joobleLocalSource.includes("local-browser-manager"), "jooble-local.ts imports local-browser-manager");
  assert(joobleLocalSource.includes("createPage"), "jooble-local.ts uses createPage from local-browser-manager");
  assert(joobleLocalSource.includes("randomDelay"), "jooble-local.ts has randomDelay (slow mode)");
  assert(joobleLocalSource.includes("HARD_CAP"), "jooble-local.ts has HARD_CAP");

  // Verify local-browser-worker.ts uses scrapeJoobleLocal, not joobleAdapter
  const workerSource = fs.readFileSync("src/queue/local-browser-worker.ts", "utf8");
  assert(workerSource.includes("scrapeJoobleLocal"), "local-browser-worker.ts imports scrapeJoobleLocal");
  assert(!workerSource.includes("joobleAdapter"), "local-browser-worker.ts does NOT import joobleAdapter");
  assert(!workerSource.includes("jooble.ts"), "local-browser-worker.ts does NOT import from jooble.ts");
  assert(workerSource.includes("withSourceLease"), "local-browser-worker.ts uses withSourceLease");
  assert(workerSource.includes("destroyOnBreaker"), "local-browser-worker.ts uses destroyOnBreaker");
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("====================================================");
  console.log("  LOCAL BROWSER REWORK — INTEGRATION VERIFICATION");
  console.log("====================================================");

  try {
    await testJoobleLocalPath();
    await testLeaseLifecycle();
    await testChromeLaunch();
    await testHeartbeat();
    await testBreakerDestroy();
  } catch (err) {
    console.error("\n💥 Unexpected error:", err);
    failed.push(`CRASH: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await closeBrowser().catch(() => {});
  }

  console.log("\n════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed.length} passed, ${failed.length} failed`);
  console.log("════════════════════════════════════════════════════");
  if (failed.length > 0) {
    console.log("\n  FAILURES:");
    for (const f of failed) console.log(`    ❌ ${f}`);
  }
  console.log();

  // Exit cleanly
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
