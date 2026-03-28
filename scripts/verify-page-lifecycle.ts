/**
 * verify-page-lifecycle.ts — P0 lifecycle 行为级 + 真实生产链路验收脚本。
 *
 * 覆盖范围：
 *  Section A — 组件级（mock/override 验证）
 *   - semaphore acquire/release、config from env、double-close、leak、force-release
 *   - high water mark、memory tracking、source concurrency config
 *   - concurrency blocking、phantom slot 回归
 *   - forceRelease reject pending waiter
 *   - timeout waiter cannot be woken
 *   - guardian over threshold → fuse → closeBrowser → openPages=0
 *   - guardian below threshold → no trip
 *   - no automation PID → guardian ignores
 *   - guardian tracking mode assertions
 *
 *  Section B — 真实 manager 启动链验收（有副作用，启动真实浏览器进程）
 *   - 通过 ensureBrowserForTest() 走生产 launchBrowser() 路径（非只读 helper）
 *   - 使用隔离临时目录，不依赖用户真实 Chrome profile
 *   - 不手动 setAutomationBrowserPid / chromium.launch
 *   - 验证: isBrowserAlive, automationBrowserPid, guardian mode=tracking_active
 *   - 验证: _guardianTick 后 cached RSS > 0（缓存值，非实时测量）
 *   - 验证: closeBrowser() 后 guardian state = no_browser, pid=null
 *   - 验收边界：仅覆盖隔离环境下的 manager 启动/关闭链，
 *     不覆盖真实 sanchez profile clone/sync 场景
 *
 * Usage:
 *   npx tsx scripts/verify-page-lifecycle.ts
 */

process.env.LOG_LEVEL = "silent";
process.env.MEMORY_SAMPLE_INTERVAL_MS = "99999999";

process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]:", err);
  process.exit(99);
});

import { getPageLifecycleTracker, resetPageLifecycleTracker } from "../src/browser/page-lifecycle.js";
import { getSourceConcurrency, getAllSourceConcurrency } from "../src/browser/source-concurrency.js";
import {
  _testSetBrowserRssOverride,
  _guardianTick,
  _testResetGuardian,
  injectCloseBrowser,
  setAutomationBrowserPid,
  getAutomationBrowserPid,
  getGuardianTrackingState,
  markBrowserLaunchedPidUnavailable,
  clearBrowserLaunchedFlag,
  type GuardianTrackingMode,
} from "../src/browser/resource-guardian.js";

let passed = 0;
let failed = 0;
const checkResults: Record<string, string> = {};

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${label}${detail ? ": " + detail : ""}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}${detail ? ": " + detail : ""}`);
  }
}

/* ═══════════════════════════════════════════════════════════════
   Section A: Component-Level Tests (same as before + mode checks)
   ═══════════════════════════════════════════════════════════════ */

async function testAcquireRelease(): Promise<void> {
  console.log("\n--- Test 1: Acquire/Release ---");
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const id1 = await t.acquireSlot("src-a");
  assert("openPages=1", t.getStats().openPages === 1);
  const id2 = await t.acquireSlot("src-a");
  assert("openPages=2", t.getStats().openPages === 2);
  t.releaseSlot(id1, "src-a");
  assert("openPages=1 after release", t.getStats().openPages === 1);
  t.releaseSlot(id2, "src-a");
  assert("openPages=0", t.getStats().openPages === 0);
  assert("closedPages=2", t.getStats().closedPages === 2);
  resetPageLifecycleTracker();
}

function testConfigFromEnv(): void {
  console.log("\n--- Test 2: Config from Env ---");
  process.env.MAX_OPEN_PAGES = "7";
  process.env.MAX_OPEN_PAGES_PER_SOURCE = "4";
  resetPageLifecycleTracker();
  const cfg = getPageLifecycleTracker().getConfig();
  assert("maxOpenPages=7", cfg.maxOpenPages === 7);
  assert("maxOpenPagesPerSource=4", cfg.maxOpenPagesPerSource === 4);
  process.env.MAX_OPEN_PAGES = "3";
  process.env.MAX_OPEN_PAGES_PER_SOURCE = "2";
  resetPageLifecycleTracker();
}

async function testDoubleClose(): Promise<void> {
  console.log("\n--- Test 3: Double Close ---");
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const id1 = await t.acquireSlot("test");
  t.releaseSlot(id1, "test");
  t.releaseSlot(id1, "test");
  assert("no underflow", t.getStats().openPages === 0);
  assert("not double counted", t.getStats().closedPages === 1);
  resetPageLifecycleTracker();
}

async function testLeak(): Promise<void> {
  console.log("\n--- Test 4: Leak ---");
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const id1 = await t.acquireSlot("test");
  t.markLeaked(id1, "test");
  assert("leakedPages=1", t.getStats().leakedPages === 1);
  assert("openPages=0", t.getStats().openPages === 0);
  resetPageLifecycleTracker();
}

async function testForceAll(): Promise<void> {
  console.log("\n--- Test 5: Force Release All ---");
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  await t.acquireSlot("a"); await t.acquireSlot("b");
  t.forceReleaseAll("test");
  assert("openPages=0", t.getStats().openPages === 0);
  assert("leaked=2", t.getStats().leakedPages === 2);
  resetPageLifecycleTracker();
}

async function testHighWater(): Promise<void> {
  console.log("\n--- Test 6: High Water ---");
  process.env.MAX_OPEN_PAGES = "5"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "5";
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const ids = [await t.acquireSlot("a"), await t.acquireSlot("a"), await t.acquireSlot("a")];
  assert("hwm=3", t.getStats().highWaterMark === 3);
  ids.forEach((id) => t.releaseSlot(id, "a"));
  assert("hwm stays 3", t.getStats().highWaterMark === 3);
  process.env.MAX_OPEN_PAGES = "3"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "2";
  resetPageLifecycleTracker();
}

function testMemory(): void {
  console.log("\n--- Test 7: Memory ---");
  resetPageLifecycleTracker();
  const s = getPageLifecycleTracker().getStats();
  assert("rss>0", s.lastMemoryRss > 0);
  assert("not over threshold", !s.memoryOverThreshold);
  resetPageLifecycleTracker();
}

function testSourceConcurrency(): void {
  console.log("\n--- Test 8: Source Concurrency ---");
  for (const s of ["jooble", "linkedin", "reed", "remoteok"])
    assert(`${s} maxPages=1`, getSourceConcurrency(s).maxPages === 1);
  for (const s of ["hn_hiring", "devitjobs"])
    assert(`${s} maxPages>=2`, getSourceConcurrency(s).maxPages >= 2);
  assert("unknown fallback=1", getSourceConcurrency("xxx").maxPages === 1);
}

async function testConcurrencyBlocks(): Promise<void> {
  console.log("\n--- Test 9: Concurrency Blocking ---");
  process.env.MAX_OPEN_PAGES = "2"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "1";
  process.env.PAGE_ACQUIRE_TIMEOUT_MS = "400";
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const id1 = await t.acquireSlot("a"); const id2 = await t.acquireSlot("b");
  const to = await t.acquireSlot("c").then(() => false).catch(() => true);
  assert("3rd blocked", to === true);
  t.releaseSlot(id1, "a"); t.releaseSlot(id2, "b");
  const id3 = await t.acquireSlot("x");
  const pst = await t.acquireSlot("x").then(() => false).catch(() => true);
  assert("per-source blocked", pst === true);
  t.releaseSlot(id3, "x");
  process.env.MAX_OPEN_PAGES = "3"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "2";
  delete process.env.PAGE_ACQUIRE_TIMEOUT_MS;
  t.forceReleaseAll("cleanup");
  resetPageLifecycleTracker();
}

async function testPhantomSlot(): Promise<void> {
  console.log("\n--- Test 10: Phantom Slot Regression ---");
  process.env.MAX_OPEN_PAGES = "2"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "2";
  process.env.PAGE_ACQUIRE_TIMEOUT_MS = "300";
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const idA = await t.acquireSlot("a"); const idB = await t.acquireSlot("b");
  let to = false;
  try { await t.acquireSlot("c"); } catch { to = true; }
  assert("3rd timed out", to);
  const w = t.getStats().acquireWaiters;
  assert("waiters=0", w === 0, `${w}`);
  assert("openPages=2", t.getStats().openPages === 2);
  t.releaseSlot(idA, "a");
  const oa = t.getStats().openPages;
  assert("openPages=1 after A", oa === 1, `${oa}`);
  t.releaseSlot(idB, "b");
  const ob = t.getStats().openPages;
  assert("openPages=0 after B", ob === 0, `${ob}`);
  checkResults["phantom_slot_check"] = (oa === 1 && ob === 0 && w === 0) ? "PASS" : "FAIL";
  checkResults["waiter_cleanup_check"] = w === 0 ? "PASS" : "FAIL";
  process.env.MAX_OPEN_PAGES = "3"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "2";
  delete process.env.PAGE_ACQUIRE_TIMEOUT_MS;
  resetPageLifecycleTracker();
}

async function testForceReleaseRejects(): Promise<void> {
  console.log("\n--- Test 11: forceRelease Rejects Waiters ---");
  process.env.MAX_OPEN_PAGES = "2"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "2";
  process.env.PAGE_ACQUIRE_TIMEOUT_MS = "60000";
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  await t.acquireSlot("a"); await t.acquireSlot("b");
  const holder = { err: null as Error | null };
  const prom = t.acquireSlot("c").catch((e: Error) => { holder.err = e; return "rejected"; });
  await new Promise((r) => setTimeout(r, 50));
  assert("waiter queued", t.getStats().acquireWaiters === 1);
  t.forceReleaseAll("test-force-release");
  const r = await prom;
  assert("rejected", r === "rejected");
  const errMsg = holder.err?.message ?? "";
  assert("err not null", holder.err !== null);
  assert("err contains reason", errMsg.includes("test-force-release"), errMsg);
  assert("waiters=0", t.getStats().acquireWaiters === 0);
  checkResults["force_release_rejects_pending_waiters"] =
    (r === "rejected" && errMsg.includes("test-force-release")) ? "PASS" : "FAIL";
  delete process.env.PAGE_ACQUIRE_TIMEOUT_MS;
  resetPageLifecycleTracker();
}

async function testTimeoutNoWake(): Promise<void> {
  console.log("\n--- Test 12: Timeout Cannot Wake ---");
  process.env.MAX_OPEN_PAGES = "1"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "1";
  process.env.PAGE_ACQUIRE_TIMEOUT_MS = "200";
  resetPageLifecycleTracker();
  const t = getPageLifecycleTracker();
  const id1 = await t.acquireSlot("a");
  let to = false;
  try { await t.acquireSlot("a"); } catch { to = true; }
  assert("timed out", to);
  t.releaseSlot(id1, "a");
  const o = t.getStats().openPages;
  assert("openPages=0 (no phantom)", o === 0, `${o}`);
  checkResults["timeout_waiter_cannot_be_woken_later"] = o === 0 ? "PASS" : "FAIL";
  delete process.env.PAGE_ACQUIRE_TIMEOUT_MS;
  resetPageLifecycleTracker();
}

/* ── Guardian component tests ── */

async function testGuardianTrips(): Promise<void> {
  console.log("\n--- Test 13: Guardian Fuse Trip ---");
  process.env.MAX_OPEN_PAGES = "3"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "3";
  process.env.GUARDIAN_MAX_CONSECUTIVE_OVER = "1";
  process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES = String(1 * 1024 * 1024 * 1024);
  resetPageLifecycleTracker(); _testResetGuardian();
  const t = getPageLifecycleTracker();
  await t.acquireSlot("a"); await t.acquireSlot("b");
  _testSetBrowserRssOverride(() => 2 * 1024 * 1024 * 1024);
  setAutomationBrowserPid(99999);
  let closeCalled = false;
  injectCloseBrowser(async () => { closeCalled = true; });

  // Check mode before tick
  const modePre = getGuardianTrackingState().mode;
  assert("mode before tick = test_override", modePre === "test_override", modePre);

  const r = await _guardianTick();
  assert("fuseTripped", r.fuseTripped);
  assert("closeBrowserCalled", r.closeBrowserCalled);
  assert("closeBrowser() ran", closeCalled);
  assert("openPages=0", t.getStats().openPages === 0);
  assert("pid cleared", getAutomationBrowserPid() === null);
  assert("mode=test_override in result", r.mode === "test_override", r.mode);
  checkResults["guardian_over_threshold_trips_cleanup"] =
    (r.fuseTripped && closeCalled && t.getStats().openPages === 0) ? "PASS" : "FAIL";
  delete process.env.GUARDIAN_MAX_CONSECUTIVE_OVER;
  delete process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES;
  _testResetGuardian(); resetPageLifecycleTracker();
}

async function testGuardianNoTrip(): Promise<void> {
  console.log("\n--- Test 14: Guardian No Trip ---");
  process.env.GUARDIAN_MAX_CONSECUTIVE_OVER = "1";
  process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES = String(4 * 1024 * 1024 * 1024);
  process.env.MAX_OPEN_PAGES = "3"; process.env.MAX_OPEN_PAGES_PER_SOURCE = "3";
  resetPageLifecycleTracker(); _testResetGuardian();
  const t = getPageLifecycleTracker();
  await t.acquireSlot("a");
  _testSetBrowserRssOverride(() => 1 * 1024 * 1024 * 1024);
  let closeCalled = false;
  injectCloseBrowser(async () => { closeCalled = true; });
  const r = await _guardianTick();
  assert("no trip", !r.fuseTripped);
  assert("no close", !closeCalled);
  assert("openPages=1", t.getStats().openPages === 1);
  delete process.env.GUARDIAN_MAX_CONSECUTIVE_OVER;
  delete process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES;
  _testResetGuardian(); resetPageLifecycleTracker();
}

async function testGuardianNoPid(): Promise<void> {
  console.log("\n--- Test 15: No PID → Guardian Ignores ---");
  process.env.GUARDIAN_MAX_CONSECUTIVE_OVER = "1";
  process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES = "100";
  resetPageLifecycleTracker(); _testResetGuardian();
  _testSetBrowserRssOverride(null);
  setAutomationBrowserPid(null as unknown as number);
  let closeCalled = false;
  injectCloseBrowser(async () => { closeCalled = true; });
  const state = getGuardianTrackingState();
  assert("mode=no_browser", state.mode === "no_browser", state.mode);
  const r = await _guardianTick();
  assert("rss=0", r.automationBrowserTreeRssMB === 0);
  assert("no trip", !r.fuseTripped);
  assert("no close", !closeCalled);
  checkResults["guardian_ignores_non_automation_browser"] = (!r.fuseTripped) ? "PASS" : "FAIL";
  delete process.env.GUARDIAN_MAX_CONSECUTIVE_OVER;
  delete process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES;
  _testResetGuardian(); resetPageLifecycleTracker();
}

/* ── Guardian mode transitions (component-level) ── */

function testGuardianModeTransitions(): void {
  console.log("\n--- Test 16: Guardian Mode Transitions ---");
  _testResetGuardian();

  // no_browser
  let s = getGuardianTrackingState();
  assert("initial mode=no_browser", s.mode === "no_browser", s.mode);

  // tracking_active
  setAutomationBrowserPid(12345);
  s = getGuardianTrackingState();
  assert("after setPid: mode=tracking_active", s.mode === "tracking_active", s.mode);
  assert("pid=12345", s.automationBrowserPid === 12345);

  // tracking_unavailable
  setAutomationBrowserPid(null);
  markBrowserLaunchedPidUnavailable();
  s = getGuardianTrackingState();
  assert("after markUnavailable: mode=tracking_unavailable", s.mode === "tracking_unavailable", s.mode);

  // back to no_browser
  clearBrowserLaunchedFlag();
  s = getGuardianTrackingState();
  assert("after clearFlag: mode=no_browser", s.mode === "no_browser", s.mode);

  // test_override
  _testSetBrowserRssOverride(() => 100);
  s = getGuardianTrackingState();
  assert("with override: mode=test_override", s.mode === "test_override", s.mode);

  _testResetGuardian();
}

/* ═══════════════════════════════════════════════════════════════
   Section B: Real Manager Launch → PID Registration → Guardian State

   Uses ensureBrowserForTest() which calls the REAL launchBrowser().
   ⚠️  This is NOT a read-only test — it starts a real browser process,
   registers the PID with ResourceGuardian, and starts the guardian timer.
   After assertions, closeBrowser() is called to tear down.

   Uses an ISOLATED temp directory (not the user’s real sanchez profile),
   so this validates the manager launch/close chain but does NOT cover
   real profile clone/sync stability.
   ═══════════════════════════════════════════════════════════════ */

async function testRealManagerLaunchPidRegistration(): Promise<void> {
  console.log("\n--- Test 17: Real Manager Launch → PID Registration ---");
  console.log("  (This test uses ensureBrowserForTest → real launchBrowser)");

  // Create isolated temp directory for automation data — avoids profile lock conflicts
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const nodeFs = await import("node:fs");
  const testDataDir = nodePath.join(os.tmpdir(), `lifecycle-manager-test-${Date.now()}`);
  nodeFs.mkdirSync(testDataDir, { recursive: true });

  // Set env vars BEFORE importing local-browser-manager (module-level config reads process.env).
  // Use a nonexistent userDataDir so syncProfileState() skips (source profile not found).
  process.env.LOCAL_BROWSER_DATA_DIR = testDataDir;
  process.env.LOCAL_BROWSER_USER_DATA_DIR = nodePath.join(os.tmpdir(), "nonexistent-chrome-data");
  process.env.LOCAL_BROWSER_PROFILE_DIRECTORY = "Default";
  process.env.LOCAL_BROWSER_HEADLESS = "true";
  // Don't reset guardian — the real manager will start its own guardian.
  // Set high threshold to prevent fuse trip.
  process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES = String(999 * 1024 * 1024 * 1024);

  const {
    ensureBrowserForTest,
    closeBrowser: realClose,
    isBrowserAlive,
  } = await import("../src/browser/local-browser-manager.js");

  try {
    // Step 1: Launch via real manager path
    await ensureBrowserForTest();

    // Step 2: Verify browser alive
    const alive = isBrowserAlive();
    assert("browserAlive=true after manager launch", alive === true);

    // Step 3: Verify guardian state — PID registered by manager, not by us
    const stateAfterLaunch = getGuardianTrackingState();
    const pid = stateAfterLaunch.automationBrowserPid;
    const mode = stateAfterLaunch.mode;

    if (pid !== null && typeof pid === "number" && pid > 0) {
      assert("automation PID registered by manager", true, `pid=${pid}`);
      checkResults["automation_pid_registration_check"] = "PASS";
      checkResults["automation_pid_value"] = String(pid);
    } else {
      // PID unavailable — could be tracking_unavailable
      assert("automation PID registered by manager", false,
        `pid=${pid}, mode=${mode} — manager did not register a real PID`);
      checkResults["automation_pid_registration_check"] = "FAIL";
      checkResults["automation_pid_value"] = "null";
    }

    assert("guardian mode after launch",
      mode === "tracking_active" || mode === "tracking_unavailable", mode);
    checkResults["guardian_tracking_mode_check"] =
      mode === "tracking_active" ? "PASS" : "FAIL";
    checkResults["guardian_mode"] = mode;

    // Step 4: Run a guardian tick to populate cached RSS, then check state
    console.log("\n--- Test 17b: Guardian Tick → Cached RSS ---");
    const tickResult = await _guardianTick();
    assert("tick automationBrowserTreeRssMB>0",
      tickResult.automationBrowserTreeRssMB > 0,
      `${tickResult.automationBrowserTreeRssMB}MB`);

    // P0-L3: Verify getGuardianTrackingState returns cached RSS (not hardcoded 0).
    // NOTE: This is a CACHED value from the tick above, not a real-time measurement.
    // After browser close, it may retain this value — use mode/pid to check liveness.
    const stateAfterTick = getGuardianTrackingState();
    assert("cached RSS in state > 0 after tick",
      stateAfterTick.automationBrowserTreeRssBytes > 0,
      `${Math.round(stateAfterTick.automationBrowserTreeRssBytes / 1024 / 1024)}MB (cached, not real-time)`);
    checkResults["guardian_state_rss_cached_check"] =
      stateAfterTick.automationBrowserTreeRssBytes > 0 ? "PASS" : "FAIL";

    // Step 5: Close via real manager closeBrowser()
    console.log("\n--- Test 18: Real Manager Close → Guardian Cleanup ---");
    await realClose();

    const aliveAfter = isBrowserAlive();
    assert("browserAlive=false after closeBrowser", aliveAfter === false);

    const stateAfterClose = getGuardianTrackingState();
    assert("after close: pid=null", stateAfterClose.automationBrowserPid === null);
    assert("after close: mode=no_browser",
      stateAfterClose.mode === "no_browser", stateAfterClose.mode);
    checkResults["guardian_cleanup_pid_clear_check"] = (
      stateAfterClose.automationBrowserPid === null &&
      stateAfterClose.mode === "no_browser"
    ) ? "PASS" : "FAIL";

  } catch (err) {
    console.log(`  [FAIL] Real manager launch failed: ${(err as Error).message}`);
    console.log(`         ${(err as Error).stack?.split("\n").slice(1, 3).join("\n         ")}`);
    failed++;
    checkResults["automation_pid_registration_check"] =
      checkResults["automation_pid_registration_check"] ?? "FAIL";
    checkResults["automation_pid_value"] =
      checkResults["automation_pid_value"] ?? "null";
    checkResults["guardian_tracking_mode_check"] =
      checkResults["guardian_tracking_mode_check"] ?? "FAIL";
    checkResults["guardian_mode"] =
      checkResults["guardian_mode"] ?? "no_browser";
    checkResults["guardian_cleanup_pid_clear_check"] =
      checkResults["guardian_cleanup_pid_clear_check"] ?? "FAIL";
    checkResults["guardian_state_rss_cached_check"] =
      checkResults["guardian_state_rss_cached_check"] ?? "FAIL";
    // Attempt cleanup
    try {
      const { closeBrowser: fallbackClose } = await import("../src/browser/local-browser-manager.js");
      await fallbackClose();
    } catch { /* ok */ }
  } finally {
    delete process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES;
    delete process.env.LOCAL_BROWSER_DATA_DIR;
    delete process.env.LOCAL_BROWSER_USER_DATA_DIR;
    delete process.env.LOCAL_BROWSER_PROFILE_DIRECTORY;
    delete process.env.LOCAL_BROWSER_HEADLESS;
    // Clean up temp directory
    try {
      const nodeFs = await import("node:fs");
      nodeFs.rmSync(testDataDir, { recursive: true, force: true });
    } catch { /* ok */ }
  }
}

/* ══════ Main ══════ */

async function main(): Promise<void> {
  console.log("=== P0 Page Lifecycle Verification ===");
  console.log("=== Section A: Component Tests + Section B: Real Browser PID Registration ===\n");

  // Section A: Component-level tests
  await testAcquireRelease();
  testConfigFromEnv();
  await testDoubleClose();
  await testLeak();
  await testForceAll();
  await testHighWater();
  testMemory();
  testSourceConcurrency();
  await testConcurrencyBlocks();
  await testPhantomSlot();
  await testForceReleaseRejects();
  await testTimeoutNoWake();
  await testGuardianTrips();
  await testGuardianNoTrip();
  await testGuardianNoPid();
  testGuardianModeTransitions();

  // Section B: Real manager launch/close PID registration
  await testRealManagerLaunchPidRegistration();

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  const checks = [
    "phantom_slot_check",
    "waiter_cleanup_check",
    "force_release_rejects_pending_waiters",
    "timeout_waiter_cannot_be_woken_later",
    "guardian_over_threshold_trips_cleanup",
    "guardian_ignores_non_automation_browser",
    "automation_pid_registration_check",
    "guardian_tracking_mode_check",
    "guardian_cleanup_pid_clear_check",
    "guardian_state_rss_cached_check",
  ];
  for (const c of checks) {
    console.log(`${c}: ${checkResults[c] ?? "NOT_RUN"}`);
  }
  if (checkResults["automation_pid_value"]) {
    console.log(`automation_pid_value: ${checkResults["automation_pid_value"]}`);
  }
  if (checkResults["guardian_mode"]) {
    console.log(`guardian_mode: ${checkResults["guardian_mode"]}`);
  }
  console.log(`P0 Lifecycle Verification: ${failed === 0 ? "PASS" : "PARTIAL_FAIL"}`);

  const fs = await import("node:fs");
  fs.mkdirSync("tmp", { recursive: true });
  const result: Record<string, unknown> = {
    passed,
    failed,
    verdict: failed === 0 ? "PASS" : "PARTIAL_FAIL",
  };
  for (const c of checks) result[c] = checkResults[c] ?? "NOT_RUN";
  result["automation_pid_value"] = checkResults["automation_pid_value"] ?? "null";
  result["guardian_mode"] = checkResults["guardian_mode"] ?? "unknown";
  fs.writeFileSync("tmp/p0-lifecycle-result.json", JSON.stringify(result, null, 2));
  console.log("Result written to tmp/p0-lifecycle-result.json");

  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

main().catch((err) => {
  console.error("[verify-page-lifecycle] crashed:", err);
  setTimeout(() => process.exit(1), 500);
});
