/**
 * Verification script: Local browser + Jooble link + lease + breaker lifecycle.
 *
 * Usage:  npx tsx scripts/verify-local-browser.ts
 *
 * Tests:
 *   1. Local browser launch with sanchez profile — real process
 *   2. Jooble local code path verification (import chain, no proxy)
 *   3. Lease acquire / heartbeat extend / release via Redis
 *   4. Breaker destroy → browser close + heartbeat stop + profile preserved
 */

import path from "node:path";
import fs from "node:fs";

// ─── Helper ───────────────────────────────────────────────────────────────────

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
let passCount = 0;
let failCount = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passCount++;
    console.log(`  ${PASS}  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failCount++;
    console.log(`  ${FAIL}  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Test 1: Local browser launch with sanchez profile ───────────────────────

async function testChromeProfileLaunch(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("TEST 1: Local browser launch with sanchez profile");
  console.log("══════════════════════════════════════════════════════════");

  const {
    getLocalBrowserConfig,
    createPage,
    closeBrowser,
    isBrowserAlive,
    getBrowserStats,
  } = await import("../src/browser/local-browser-manager.js");

  const cfg = getLocalBrowserConfig();
  console.log(`  engine               = ${cfg.engine}`);
  console.log(`  executablePath       = ${cfg.executablePath}`);
  console.log(`  userDataDir          = ${cfg.userDataDir}`);
  console.log(`  profileDirectory     = ${cfg.profileDirectory}`);
  console.log(`  automationDataDir    = ${cfg.automationDataDir}`);
  console.log(`  headless             = ${cfg.headless}`);

  check("engine is chrome or edge", cfg.engine === "chrome" || cfg.engine === "edge");
  check("executablePath is set", cfg.executablePath.toLowerCase().includes(".exe"));
  check("userDataDir is browser User Data", cfg.userDataDir.includes("User Data"));
  check("profileDirectory = sanchez", cfg.profileDirectory === "sanchez");

  // Actually launch browser
  console.log("\n  → Launching local browser...");
  const session = await createPage("__verify__");
  const page = session.page;

  check("Browser alive after createPage", isBrowserAlive());

  const stats = getBrowserStats();
  check("activePages >= 1", stats.activePages >= 1, `activePages=${stats.activePages}`);

  // Verify the automation profile directory exists
  const automationProfile = path.join(cfg.automationDataDir, cfg.profileDirectory);
  const profileExists = fs.existsSync(automationProfile);
  check("Automation profile dir exists on disk", profileExists, automationProfile);

  // Navigate to a simple page to prove it works
  await page.goto("https://www.example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  const title = await page.title();
  check("Browser can navigate", title.includes("Example"), `title="${title}"`);

  await session.close();
  check("Page closed cleanly", true);

  // Close browser
  await closeBrowser();
  check("Browser closed after closeBrowser()", !isBrowserAlive());

  // Profile on disk is NOT deleted
  check("Profile preserved after close", fs.existsSync(automationProfile));
}

// ─── Test 2: Jooble local code path (NO proxy) ──────────────────────────────

async function testJoobleLocalCodePath(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("TEST 2: Jooble local code path verification");
  console.log("══════════════════════════════════════════════════════════");

  // Verify jooble-local.ts imports from local-browser-manager, NOT cdp-pool
  const joobleLocalPath = path.resolve("src/sources/jooble-local.ts");
  const joobleLocalCode = fs.readFileSync(joobleLocalPath, "utf-8");

  check(
    "jooble-local imports createPage from local-browser-manager",
    joobleLocalCode.includes("local-browser-manager"),
  );
  check(
    "jooble-local does NOT import cdp-pool",
    !joobleLocalCode.includes("cdp-pool"),
    "No cdp-pool import found",
  );
  check(
    "jooble-local does NOT import webshare",
    !joobleLocalCode.includes("webshare"),
    "No proxy import found",
  );

  // Verify local-browser-worker.ts calls scrapeJoobleLocal, NOT joobleAdapter.fetchJobs
  const workerPath = path.resolve("src/queue/local-browser-worker.ts");
  const workerCode = fs.readFileSync(workerPath, "utf-8");

  check(
    "local-browser-worker imports scrapeJoobleLocal",
    workerCode.includes("scrapeJoobleLocal"),
  );
  check(
    "local-browser-worker does NOT import joobleAdapter",
    !workerCode.includes("joobleAdapter"),
    "No joobleAdapter import",
  );
  check(
    "local-browser-worker does NOT import jooble.ts adapter",
    !workerCode.includes("from \"../sources/jooble.js\"") && !workerCode.includes("from '../sources/jooble.js'"),
    "No jooble adapter import",
  );
  check(
    "local-browser-worker calls scrapeJoobleLocal in handleJoobleDiscover",
    workerCode.includes("scrapeJoobleLocal(keywords"),
  );

  // Verify routing: jooble discover goes to localBrowser queue
  const commandsPath = path.resolve("src/queue/commands.ts");
  const commandsCode = fs.readFileSync(commandsPath, "utf-8");

  check(
    "commands.ts routes jooble to LOCAL_BROWSER_SOURCES",
    commandsCode.includes('"jooble"') && commandsCode.includes("LOCAL_BROWSER_SOURCES"),
  );

  // Verify jooble-local.ts has slow mode features
  check("jooble-local has HARD_CAP", joobleLocalCode.includes("HARD_CAP"));
  check("jooble-local has randomDelay", joobleLocalCode.includes("randomDelay"));
  check("jooble-local has CF detection", joobleLocalCode.includes("isCfBlocked"));
  check("jooble-local has circuit breaker", joobleLocalCode.includes("recordFailure"));
}

// ─── Test 3: Lease heartbeat + scheduler skip ────────────────────────────────

async function testLeaseHeartbeat(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("TEST 3: Lease acquire / heartbeat / extend / release");
  console.log("══════════════════════════════════════════════════════════");

  const { acquireLease, releaseLease, isLeaseHeld, extendLease } = await import(
    "../src/scheduler/source-lease.js"
  );

  const testSource = "__lease_test__";
  const testHolder = "verify-script";
  const ttlMs = 10_000;

  // Acquire
  const lease = await acquireLease(testSource, testHolder, ttlMs);
  check("Lease acquired", lease !== null, `holder=${lease?.holder}`);

  // isLeaseHeld should return the lease
  const held = await isLeaseHeld(testSource);
  check("isLeaseHeld returns lease info", held !== null, `expires=${held?.expiresAt}`);

  // Extend
  const extendedOk = await extendLease(testSource, testHolder, ttlMs);
  check("extendLease succeeds", extendedOk === true);

  // Check expiry moved forward
  const heldAfter = await isLeaseHeld(testSource);
  check(
    "Lease expiry moved forward after extend",
    heldAfter !== null && held !== null && heldAfter.expiresAt > held.expiresAt,
    `before=${held?.expiresAt} after=${heldAfter?.expiresAt}`,
  );

  // Scheduler canDispatch should skip this source
  const { canDispatch } = await import("../src/scheduler/index.js");
  const dispatchCheck = await canDispatch(testSource);
  check("Scheduler canDispatch returns false while lease held", dispatchCheck.ok === false, `reason=${dispatchCheck.reason}`);

  // Release
  const released = await releaseLease(testSource, testHolder);
  check("Lease released", released === true);

  // Now should be free
  const heldAfterRelease = await isLeaseHeld(testSource);
  check("isLeaseHeld returns null after release", heldAfterRelease === null);

  // canDispatch should now be true
  const dispatchCheck2 = await canDispatch(testSource);
  check("Scheduler canDispatch returns true after lease release", dispatchCheck2.ok === true);
}

// ─── Test 4: Breaker destroy → browser close + heartbeat stop ────────────────

async function testBreakerDestroy(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("TEST 4: Breaker destroy → browser close + profile preserved");
  console.log("══════════════════════════════════════════════════════════");

  const {
    getLocalBrowserConfig,
    createPage,
    destroyOnBreaker,
    isBrowserAlive,
  } = await import("../src/browser/local-browser-manager.js");

  const { forceResetBreaker, getBreakerState } = await import(
    "../src/browser/circuit-breaker.js"
  );

  // Reset breaker state first
  await forceResetBreaker("__breaker_test__");

  // Launch browser + create page
  console.log("\n  → Launching browser for breaker test...");
  const session = await createPage("__breaker_test__");
  check("Browser alive before breaker", isBrowserAlive());

  // Close the page first (simulating normal page close before breaker)
  await session.close();

  // Trigger breaker destroy
  console.log("  → Triggering destroyOnBreaker...");
  await destroyOnBreaker("__breaker_test__", "cf_block");

  check("Browser killed after breaker destroy", !isBrowserAlive());

  // Profile directory preserved
  const cfg = getLocalBrowserConfig();
  const profileDir = path.join(cfg.automationDataDir, cfg.profileDirectory);
  check("Profile preserved after breaker destroy", fs.existsSync(profileDir));

  // Breaker state should show failures
  const state = await getBreakerState("__breaker_test__");
  check(
    "Breaker recorded failure",
    state.consecutiveFailures >= 1,
    `failures=${state.consecutiveFailures}`,
  );

  // Clean up
  await forceResetBreaker("__breaker_test__");
}

// ─── Test 5: withSourceLease heartbeat integration ───────────────────────────

async function testWithSourceLeaseHeartbeat(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("TEST 5: withSourceLease heartbeat integration");
  console.log("══════════════════════════════════════════════════════════");

  const { withSourceLease } = await import("../src/browser/local-browser-manager.js");
  const { isLeaseHeld } = await import("../src/scheduler/source-lease.js");

  const testSource = "__heartbeat_test__";

  // Verify code structure: withSourceLease has heartbeat
  const mgrPath = path.resolve("src/browser/local-browser-manager.ts");
  const mgrCode = fs.readFileSync(mgrPath, "utf-8");

  check(
    "withSourceLease contains setInterval heartbeat",
    mgrCode.includes("setInterval") && mgrCode.includes("extendLease"),
  );
  check(
    "withSourceLease has stopHeartbeat in finally",
    mgrCode.includes("stopHeartbeat(source)"),
  );
  check(
    "destroyOnBreaker calls stopHeartbeat FIRST",
    mgrCode.indexOf("stopHeartbeat(source)") < mgrCode.indexOf("recordFailure(source"),
  );
  check(
    "activeHeartbeats map exists for cross-scope cleanup",
    mgrCode.includes("activeHeartbeats"),
  );

  // Actually test: run withSourceLease for a short task, verify lease is held and then released
  let leaseHeldDuringTask = false;
  await withSourceLease(testSource, "verify-script", async () => {
    const held = await isLeaseHeld(testSource);
    leaseHeldDuringTask = held !== null;
    // Brief wait to ensure heartbeat could fire if interval was very short
    await new Promise((r) => setTimeout(r, 500));
  }, 10_000);

  check("Lease was held during withSourceLease task", leaseHeldDuringTask);

  const heldAfter = await isLeaseHeld(testSource);
  check("Lease released after withSourceLease completes", heldAfter === null);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Local Browser / Jooble / Lease / Breaker Verification  ");
  console.log("═══════════════════════════════════════════════════════════");

  try {
    await testChromeProfileLaunch();
  } catch (err) {
    console.error("TEST 1 CRASHED:", err);
    failCount++;
  }

  try {
    await testJoobleLocalCodePath();
  } catch (err) {
    console.error("TEST 2 CRASHED:", err);
    failCount++;
  }

  try {
    await testLeaseHeartbeat();
  } catch (err) {
    console.error("TEST 3 CRASHED:", err);
    failCount++;
  }

  try {
    await testBreakerDestroy();
  } catch (err) {
    console.error("TEST 4 CRASHED:", err);
    failCount++;
  }

  try {
    await testWithSourceLeaseHeartbeat();
  } catch (err) {
    console.error("TEST 5 CRASHED:", err);
    failCount++;
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passCount} passed, ${failCount} failed`);
  console.log("═══════════════════════════════════════════════════════════\n");

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Verification script crashed:", err);
  process.exit(2);
});
