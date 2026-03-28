import { chromium, type Page, type BrowserContext } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import {
  recordSuccess,
  recordFailure,
  isSourceInCooldown,
  forceOpenBreaker,
  type FailureType,
} from "./circuit-breaker.js";
import { acquireLease, releaseLease, extendLease } from "../scheduler/source-lease.js";
import { getPageLifecycleTracker } from "./page-lifecycle.js";
import { enforceSourceDelay } from "./source-concurrency.js";
import {
  injectCloseBrowser,
  startResourceGuardian,
  setAutomationBrowserPid,
  markBrowserLaunchedPidUnavailable,
  clearBrowserLaunchedFlag,
} from "./resource-guardian.js";
import * as fs from "node:fs";
import * as path from "node:path";

const log = createChildLogger({ module: "local-browser-mgr" });

export type LocalBrowserEngine = "chrome" | "edge";

export interface ProfileSyncStatus {
  pending: boolean;
  pendingSince: string | null;
  lastAction: "none" | "immediate" | "deferred";
}

export interface LocalBrowserConfig {
  /** Local browser engine for automation. */
  engine: LocalBrowserEngine;
  executablePath: string;
  /** The user's real browser user data directory (source of login state). */
  userDataDir: string;
  /** Profile sub-directory within userDataDir (e.g. "sanchez"). */
  profileDirectory: string;
  /**
   * Separate working directory for automation clone.
   * NOT a live profile attach — this is an explicit automation copy.
   * Avoids Chrome single-instance lock conflict when the user's own Chrome is running.
   * Key files (Cookies, Login Data, etc.) are synced from the real profile
   * according to syncTtlMs.
   */
  automationDataDir: string;
  /**
   * How long the .synced marker is considered fresh (ms).
   * After this TTL, next browser launch will re-copy from the source profile.
   * Default: 4 hours. Set to 0 to resync every launch.
   */
  syncTtlMs: number;
  /**
   * If true, always resync from source profile before every launch,
   * regardless of syncTtlMs. Useful for sessions that need fresh login state.
   */
  resyncBeforeLaunch: boolean;
  headless: boolean;
  idleTimeoutMs: number;
  /** Interval between lease heartbeat calls (ms). Default 60000. */
  heartbeatIntervalMs: number;
  breakerMaxFailures: number;
  breakerCooldownMs: number;
}

const DEFAULT_EXECUTABLE_BY_ENGINE: Record<LocalBrowserEngine, string> = {
  chrome: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  edge: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
};

const DEFAULT_USER_DATA_BY_ENGINE: Record<LocalBrowserEngine, string> = {
  chrome: "C:\\Users\\rick\\AppData\\Local\\Google\\Chrome\\User Data",
  edge: "C:\\Users\\rick\\AppData\\Local\\Microsoft\\Edge\\User Data",
};

function resolveEngine(raw?: string): LocalBrowserEngine {
  return raw?.toLowerCase() === "edge" ? "edge" : "chrome";
}

const engine = resolveEngine(process.env.LOCAL_BROWSER_ENGINE);

const config: LocalBrowserConfig = {
  engine,
  executablePath:
    process.env.LOCAL_BROWSER_EXECUTABLE_PATH
      ?? process.env.CHROME_EXECUTABLE_PATH
      ?? DEFAULT_EXECUTABLE_BY_ENGINE[engine],
  userDataDir:
    process.env.LOCAL_BROWSER_USER_DATA_DIR
      ?? process.env.CHROME_USER_DATA_DIR
      ?? DEFAULT_USER_DATA_BY_ENGINE[engine],
  profileDirectory:
    process.env.LOCAL_BROWSER_PROFILE_DIRECTORY
      ?? process.env.CHROME_PROFILE_DIRECTORY
      ?? "sanchez",
  automationDataDir: process.env.LOCAL_BROWSER_DATA_DIR ??
    path.join(process.cwd(), ".local-browser-data"),
  syncTtlMs: parseInt(process.env.PROFILE_SYNC_TTL_MS ?? String(4 * 60 * 60 * 1000), 10),
  resyncBeforeLaunch: process.env.PROFILE_RESYNC_BEFORE_LAUNCH === "true",
  headless: process.env.LOCAL_BROWSER_HEADLESS !== "false",
  idleTimeoutMs: parseInt(process.env.LOCAL_BROWSER_IDLE_TIMEOUT_MS ?? "300000", 10),
  heartbeatIntervalMs: parseInt(process.env.LEASE_HEARTBEAT_INTERVAL_MS ?? "60000", 10),
  breakerMaxFailures: parseInt(process.env.BREAKER_MAX_FAILURES ?? "3", 10),
  breakerCooldownMs: parseInt(process.env.BREAKER_COOLDOWN_MS ?? "1800000", 10),
};

const PROFILE_FILES_TO_SYNC = [
  "Cookies",
  "Cookies-journal",
  "Login Data",
  "Login Data-journal",
  "Web Data",
  "Web Data-journal",
  "Preferences",
  "Secure Preferences",
  "Network",
];

/**
 * Sync profile state from user's real browser profile to the automation clone directory.
 *
 * Strategy: explicit automation clone (NOT live profile attach).
 */
function syncProfileState(force: boolean = false): void {
  const srcProfile = path.join(config.userDataDir, config.profileDirectory);
  const dstProfile = path.join(config.automationDataDir, config.profileDirectory);

  if (!fs.existsSync(srcProfile)) {
    log.warn({ srcProfile }, "Source browser profile not found — skipping sync");
    return;
  }

  fs.mkdirSync(dstProfile, { recursive: true });

  const dstMarker = path.join(dstProfile, ".synced");
  let needsSync = force || !fs.existsSync(dstMarker);

  if (!needsSync && config.resyncBeforeLaunch) {
    needsSync = true;
    log.info("resyncBeforeLaunch=true — forcing profile resync");
  }

  if (!needsSync && config.syncTtlMs === 0) {
    needsSync = true;
    log.info("syncTtlMs=0 — forcing profile resync every launch");
  }

  if (!needsSync && config.syncTtlMs > 0 && fs.existsSync(dstMarker)) {
    const markerContent = fs.readFileSync(dstMarker, "utf-8").trim();
    const syncedAt = new Date(markerContent).getTime();
    const age = Date.now() - syncedAt;
    if (age > config.syncTtlMs) {
      needsSync = true;
      log.info({ ageMs: age, ttlMs: config.syncTtlMs }, "Profile sync TTL expired — resyncing");
    }
  }

  if (!needsSync) {
    log.debug("Automation profile clone still fresh — skipping copy");
    return;
  }

  log.info({
    engine: config.engine,
    sourceProfile: srcProfile,
    automationClone: dstProfile,
    strategy: "automation-profile-clone",
    forced: force,
  }, "Syncing browser profile clone for automation (NOT live attach)");

  for (const item of PROFILE_FILES_TO_SYNC) {
    const srcPath = path.join(srcProfile, item);
    const dstPath = path.join(dstProfile, item);
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    } catch {
      // File may not exist in source profile — expected for some items
    }
  }

  // Copy Local Storage if present (for site-specific login tokens)
  const srcLs = path.join(srcProfile, "Local Storage");
  if (fs.existsSync(srcLs)) {
    fs.cpSync(srcLs, path.join(dstProfile, "Local Storage"), { recursive: true, force: true });
  }

  fs.writeFileSync(dstMarker, new Date().toISOString());
  log.info({
    engine: config.engine,
    sourceProfile: srcProfile,
    automationClone: dstProfile,
  }, "Profile clone sync complete");
}

interface BrowserInstance {
  context: BrowserContext;
  activePagesCount: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let instance: BrowserInstance | null = null;
let launching = false;
let profileResyncPending = false;
let profileResyncPendingSince: number | null = null;
let lastProfileResyncAction: "none" | "immediate" | "deferred" = "none";
let drainingDeferredResync = false;
let guardianStarted = false;

export function getLocalBrowserConfig(): LocalBrowserConfig {
  return { ...config };
}

export function updateLocalBrowserConfig(partial: Partial<LocalBrowserConfig>): void {
  Object.assign(config, partial);
}

export function getProfileSyncStatus(): ProfileSyncStatus {
  return {
    pending: profileResyncPending,
    pendingSince: profileResyncPendingSince ? new Date(profileResyncPendingSince).toISOString() : null,
    lastAction: lastProfileResyncAction,
  };
}

function hasActiveBrowserSession(): boolean {
  return Boolean(instance) || launching;
}

function scheduleDeferredProfileResync(reason: string): void {
  profileResyncPending = true;
  if (!profileResyncPendingSince) profileResyncPendingSince = Date.now();
  lastProfileResyncAction = "deferred";
  log.info(
    {
      reason,
      activeBrowser: Boolean(instance),
      launching,
      pendingSince: profileResyncPendingSince ? new Date(profileResyncPendingSince).toISOString() : null,
    },
    "Profile resync deferred until browser/context fully closes",
  );
}

function runDeferredProfileResyncIfNeeded(trigger: string): void {
  if (!profileResyncPending || hasActiveBrowserSession() || drainingDeferredResync) return;
  drainingDeferredResync = true;
  try {
    log.info({ trigger }, "Running deferred profile resync now");
    syncProfileState(true);
    profileResyncPending = false;
    profileResyncPendingSince = null;
    lastProfileResyncAction = "immediate";
  } finally {
    drainingDeferredResync = false;
  }
}

/**
 * Close stale about:blank or other default pages left by persistent context.
 * This prevents tab accumulation from session restore.
 * IMPORTANT: Always keep at least one page open — closing ALL pages in a
 * persistent context causes the Chromium process to exit immediately.
 */
async function closeDefaultPages(context: BrowserContext): Promise<void> {
  const pages = context.pages();
  const defaultUrls = new Set(["about:blank", "chrome://newtab/", "edge://newtab/"]);
  const toClose = pages.filter((p) => {
    try { return defaultUrls.has(p.url()); } catch { return false; }
  });

  // Keep at least one page to prevent browser process exit
  const maxCloseable = Math.max(0, toClose.length - 1);
  for (let i = 0; i < maxCloseable; i++) {
    const page = toClose[i];
    if (!page) continue;
    try {
      const url = page.url();
      await page.close();
      log.debug({ url }, "Closed default/stale page from persistent context");
    } catch {
      // Page may already be closed
    }
  }
}

async function launchBrowser(): Promise<BrowserInstance> {
  if (instance) return instance;
  if (launching) {
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (instance && !launching) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
    return instance!;
  }

  launching = true;
  try {
    if (profileResyncPending) {
      log.info("Applying deferred profile resync before launching browser");
      syncProfileState(true);
      profileResyncPending = false;
      profileResyncPendingSince = null;
      lastProfileResyncAction = "immediate";
    } else {
      syncProfileState();
    }

    log.info({
      engine: config.engine,
      executablePath: config.executablePath,
      sourceProfileDir: path.join(config.userDataDir, config.profileDirectory),
      automationCloneDir: path.join(config.automationDataDir, config.profileDirectory),
      profileDirectory: config.profileDirectory,
      strategy: "automation-profile-clone",
      headless: config.headless,
    }, `Launching local ${config.engine} browser — clone of profile=${config.profileDirectory} (NOT live attach)`);

    const context = await chromium.launchPersistentContext(
      config.automationDataDir,
      {
        executablePath: config.executablePath,
        headless: config.headless,
        args: [
          `--profile-directory=${config.profileDirectory}`,
          "--no-first-run",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--disable-default-apps",
          // P0: prevent session restore — no reopening old tabs
          "--no-restore-state",
          "--disable-session-crashed-bubble",
          "--disable-features=InfiniteSessionRestore",
          // P0: limit internal process count
          "--renderer-process-limit=4",
          "--disable-background-networking",
        ],
        viewport: { width: 1366, height: 768 },
        ignoreDefaultArgs: ["--enable-automation"],
      },
    );

    // P0: Close any default/restored pages immediately
    await closeDefaultPages(context);

    const inst: BrowserInstance = {
      context,
      activePagesCount: 0,
      lastActivityAt: Date.now(),
      idleTimer: null,
    };

    context.on("close", () => {
      log.info("Local browser closed");
      const tracker = getPageLifecycleTracker();
      tracker.forceReleaseAll("browser-context-closed");
      instance = null;
      // P0-L2: Ensure guardian state is cleaned up on ANY close path
      // (crash, external kill, idle timeout, breaker destroy)
      setAutomationBrowserPid(null);
      clearBrowserLaunchedFlag();
      runDeferredProfileResyncIfNeeded("context-close-event");
    });

    instance = inst;
    resetIdleTimer();

    // Register automation browser PID for guardian memory tracking
    const resolvedPid = await resolveAutomationBrowserPid(context);
    if (resolvedPid !== null) {
      setAutomationBrowserPid(resolvedPid);
      log.info({ automationPid: resolvedPid, pidRegistration: "success" },
        "Automation browser PID registered for guardian tracking");
    } else {
      markBrowserLaunchedPidUnavailable();
      log.warn({ pidRegistration: "unavailable" },
        "Automation browser PID unavailable — guardian tracking degraded");
    }

    // Start resource guardian on first browser launch
    if (!guardianStarted) {
      injectCloseBrowser(closeBrowser);
      startResourceGuardian();
      guardianStarted = true;
    }

    log.info({
      engine: config.engine,
      executablePath: config.executablePath,
      sourceProfileDir: path.join(config.userDataDir, config.profileDirectory),
      automationCloneDir: path.join(config.automationDataDir, config.profileDirectory),
      profileDirectory: config.profileDirectory,
      strategy: "automation-profile-clone",
    }, `✓ ${config.engine} browser launched — automation clone of profile=${config.profileDirectory}`);
    return inst;
  } finally {
    launching = false;
  }
}

function resetIdleTimer(): void {
  if (!instance) return;
  if (instance.idleTimer) clearTimeout(instance.idleTimer);
  instance.idleTimer = setTimeout(async () => {
    if (instance && instance.activePagesCount === 0) {
      log.info("Idle timeout reached — closing local browser");
      await closeBrowser();
    }
  }, config.idleTimeoutMs);
}

/**
 * Resolve the automation browser's root PID from a BrowserContext.
 *
 * Playwright persistent context does NOT expose `browser().process()`.
 * The reliable way is through CDP: `browser().newBrowserCDPSession()` →
 * `SystemInfo.getProcessInfo` → find `type=browser` → `id` is the PID.
 *
 * Returns: number (PID) or null (unavailable).
 * Exported so verification scripts can reuse this logic.
 */
export async function resolveAutomationBrowserPid(context: BrowserContext): Promise<number | null> {
  try {
    const browser = context.browser();
    if (!browser) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cdp = await (browser as any).newBrowserCDPSession();
    try {
      const info = await cdp.send("SystemInfo.getProcessInfo");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const browserProc = (info as any).processInfo?.find((p: any) => p.type === "browser");
      if (browserProc && typeof browserProc.id === "number" && browserProc.id > 0) {
        return browserProc.id;
      }
    } finally {
      try { await cdp.detach(); } catch { /* ok */ }
    }
  } catch {
    // CDP approach failed — Chromium-only, acceptable to return null
  }
  return null;
}

export async function closeBrowser(): Promise<void> {
  if (!instance) {
    runDeferredProfileResyncIfNeeded("closeBrowser-no-instance");
    return;
  }
  const inst = instance;
  instance = null;
  if (inst.idleTimer) clearTimeout(inst.idleTimer);

  // P0: Force-release all tracked pages before closing context
  const tracker = getPageLifecycleTracker();
  tracker.forceReleaseAll("closeBrowser");

  // Clear automation browser PID and launched flag — browser is being destroyed
  setAutomationBrowserPid(null);
  clearBrowserLaunchedFlag();

  try {
    await inst.context.close();
  } catch (err) {
    log.warn({ err }, "Error closing local browser context");
  }
  log.info("Local browser process closed (profile preserved on disk)");
  runDeferredProfileResyncIfNeeded("closeBrowser");
}

const SEVERE_BREAKER_FAILURES = new Set<FailureType>(["cf_block", "login_failure", "authwall"]);

/**
 * destroyOnBreaker applies stratified breaker semantics:
 *   - severe failures (cf_block/login_failure/authwall): immediate cooldown via forceOpenBreaker
 *   - transient failures (timeout/transient_network/tunnel_failure/parse_error): incremental recordFailure
 */
export async function destroyOnBreaker(source: string, failureType: FailureType): Promise<void> {
  const severe = SEVERE_BREAKER_FAILURES.has(failureType);
  log.warn(
    { source, failureType, severe },
    severe
      ? "destroyOnBreaker — severe failure: immediate cooldown + runtime cleanup"
      : "destroyOnBreaker — transient failure: incremental breaker + runtime cleanup",
  );

  // 1. Stop any running heartbeat for this source FIRST
  stopHeartbeat(source);

  // 2. Stratified breaker update
  if (severe) {
    await forceOpenBreaker(source, failureType, config.breakerCooldownMs);
  } else {
    await recordFailure(source, failureType, {
      maxFailures: config.breakerMaxFailures,
      cooldownMs: config.breakerCooldownMs,
    });
  }

  // 3. Kill browser process (profile clone on disk preserved)
  await closeBrowser();

  log.info(
    {
      source,
      failureType,
      severe,
      maxFailures: config.breakerMaxFailures,
      cooldownMs: config.breakerCooldownMs,
    },
    severe
      ? "destroyOnBreaker complete: immediate cooldown + browser closed + profile preserved"
      : "destroyOnBreaker complete: incremental failure recorded + browser closed + profile preserved",
  );
}

/**
 * Force re-sync of profile clone from user's real Chrome.
 */
export function invalidateProfileSync(): void {
  const marker = path.join(config.automationDataDir, config.profileDirectory, ".synced");
  try { fs.unlinkSync(marker); } catch { /* ok */ }
  log.info("Profile clone sync invalidated — will re-copy from source on next launch");
}

/**
 * Force immediate resync now (without waiting for next launch).
 */
export function forceResyncProfileNow(): ProfileSyncStatus {
  if (hasActiveBrowserSession()) {
    scheduleDeferredProfileResync("forceResyncProfileNow while browser/context is active");
    return getProfileSyncStatus();
  }

  log.info("forceResyncProfileNow executing immediately (no active browser/context)");
  invalidateProfileSync();
  syncProfileState(true);
  profileResyncPending = false;
  profileResyncPendingSince = null;
  lastProfileResyncAction = "immediate";
  return getProfileSyncStatus();
}

export interface PageSession {
  page: Page;
  close: () => Promise<void>;
}

/**
 * Create a page with lifecycle-tracked semaphore.
 *
 * P0 guarantees:
 *   - Blocks if global/per-source page limit reached
 *   - Every page has a unique lifecycle ID tracked by PageLifecycleTracker
 *   - close() releases the semaphore slot and closes the page
 *   - On failure, the slot is released via finally
 */
export async function createPage(source: string): Promise<PageSession> {
  const inCooldown = await isSourceInCooldown(source);
  if (inCooldown) {
    throw new Error(`Source ${source} is in circuit breaker cooldown`);
  }

  const tracker = getPageLifecycleTracker();

  // P0: Check memory threshold before even queuing
  if (tracker.isMemoryOverThreshold()) {
    log.warn({ source }, "Memory over threshold — refusing page creation until memory recovers");
    throw new Error(`Memory threshold exceeded — cannot create page for ${source}`);
  }

  // P0: Enforce inter-page delay for this source
  await enforceSourceDelay(source);

  // P0: Acquire semaphore slot (blocks if at capacity)
  const pageId = await tracker.acquireSlot(source);

  let page: Page;
  try {
    const inst = await launchBrowser();
    page = await inst.context.newPage();
    inst.activePagesCount++;
    inst.lastActivityAt = Date.now();

    log.debug({ source, pageId, activePages: inst.activePagesCount }, "Created new page (lifecycle-tracked)");
  } catch (err) {
    // Failed to create page — release the semaphore slot
    tracker.releaseSlot(pageId, source);
    throw err;
  }

  let closed = false;
  const close = async () => {
    if (closed) return; // Prevent double-close
    closed = true;
    try {
      if (!page.isClosed()) await page.close();
    } catch { /* already closed */ }
    // P0: Release lifecycle tracker slot
    tracker.releaseSlot(pageId, source);
    if (instance) {
      instance.activePagesCount = Math.max(0, instance.activePagesCount - 1);
      instance.lastActivityAt = Date.now();
      resetIdleTimer();
      log.debug({ source, pageId, activePages: instance.activePagesCount }, "Page closed (lifecycle-tracked)");
    }
  };

  return { page, close };
}

export async function withLocalPage<T>(
  source: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const session = await createPage(source);
  try {
    const result = await fn(session.page);
    await recordSuccess(source);
    return result;
  } catch (err) {
    throw err;
  } finally {
    await session.close();
  }
}

/** Heartbeat interval — configurable via config.heartbeatIntervalMs (env: LEASE_HEARTBEAT_INTERVAL_MS) */

/**
 * Per-source heartbeat registry: allows destroyOnBreaker to cancel an active
 * heartbeat timer even from outside the withSourceLease scope.
 */
const activeHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

function stopHeartbeat(source: string): void {
  const hb = activeHeartbeats.get(source);
  if (hb) {
    clearInterval(hb);
    activeHeartbeats.delete(source);
    log.debug({ source }, "Heartbeat timer stopped");
  }
}

export async function withSourceLease<T>(
  source: string,
  holder: string,
  fn: () => Promise<T>,
  ttlMs: number = 15 * 60 * 1000,
): Promise<T> {
  const lease = await acquireLease(source, holder, ttlMs);
  if (!lease) {
    throw new Error(`Cannot acquire lease for source ${source} — another task is running`);
  }

  // Register heartbeat in shared map (so destroyOnBreaker can stop it)
  const hbInterval = config.heartbeatIntervalMs;
  log.info({ source, holder, heartbeatIntervalMs: hbInterval, ttlMs }, "Lease heartbeat started");
  const heartbeat = setInterval(async () => {
    try {
      const ok = await extendLease(source, holder, ttlMs);
      if (ok) {
        log.info({ source, holder }, "Lease heartbeat — extended");
      } else {
        log.warn({ source, holder }, "Lease heartbeat — extension failed (lease may have been stolen)");
      }
    } catch (err) {
      log.warn({ source, holder, err }, "Lease heartbeat error");
    }
  }, hbInterval);
  activeHeartbeats.set(source, heartbeat);

  try {
    return await fn();
  } finally {
    // Ensure heartbeat is always cleaned up — normal exit, error, or breaker
    stopHeartbeat(source);
    try {
      await releaseLease(source, holder);
    } catch (err) {
      log.warn({ source, holder, err }, "Failed to release lease in finally block");
    }
  }
}

export function isBrowserAlive(): boolean {
  return instance !== null;
}

export function getBrowserStats(): {
  alive: boolean;
  activePages: number;
  lastActivityAt: number | null;
} {
  return {
    alive: instance !== null,
    activePages: instance?.activePagesCount ?? 0,
    lastActivityAt: instance?.lastActivityAt ?? null,
  };
}

/**
 * Get comprehensive lifecycle stats (P0 telemetry).
 * Includes page lifecycle tracking + browser instance stats.
 */
export function getLifecycleStats(): {
  browser: ReturnType<typeof getBrowserStats>;
  pages: import("./page-lifecycle.js").PageLifecycleStats;
  config: { maxOpenPages: number; maxOpenPagesPerSource: number };
} {
  const tracker = getPageLifecycleTracker();
  return {
    browser: getBrowserStats(),
    pages: tracker.getStats(),
    config: {
      maxOpenPages: tracker.getConfig().maxOpenPages,
      maxOpenPagesPerSource: tracker.getConfig().maxOpenPagesPerSource,
    },
  };
}

/**
 * P0 verification entry point: triggers the real production launchBrowser() path
 * without creating a business page.
 *
 * ⚠️  THIS IS NOT A READ-ONLY HELPER. Calling this has full production side effects:
 *   - Starts a real browser process (Chrome/Edge)
 *   - Registers automation PID with ResourceGuardian
 *   - Starts the ResourceGuardian interval timer (if first launch)
 *   - Sets the module-level `instance` (idle timer, activePagesCount, etc.)
 *
 * ONLY for use in verification/test scripts — not part of the business API.
 * After calling this, the caller MUST call closeBrowser() to tear down the
 * browser process and clean up guardian state.
 */
export async function ensureBrowserForTest(): Promise<void> {
  await launchBrowser();
}
