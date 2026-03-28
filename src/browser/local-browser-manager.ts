import { chromium, type Page, type BrowserContext } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import { recordFailure, recordSuccess, isSourceInCooldown, type FailureType } from "./circuit-breaker.js";
import { acquireLease, releaseLease, extendLease } from "../scheduler/source-lease.js";
import * as fs from "node:fs";
import * as path from "node:path";

const log = createChildLogger({ module: "local-browser-mgr" });

export interface LocalBrowserConfig {
  chromeExecutablePath: string;
  /** The user's real Chrome user data directory (source of login state). */
  userDataDir: string;
  /** Profile sub-directory within userDataDir (e.g. "sanchez"). */
  profileDirectory: string;
  /**
   * Separate working directory for automation. Avoids Chrome single-instance
   * lock conflict when the user's own Chrome is running.
   * The sanchez profile's key files are synced here on first launch.
   */
  automationDataDir: string;
  headless: boolean;
  idleTimeoutMs: number;
  breakerMaxFailures: number;
  breakerCooldownMs: number;
}

const config: LocalBrowserConfig = {
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  userDataDir: process.env.CHROME_USER_DATA_DIR ?? "C:\\Users\\rick\\AppData\\Local\\Google\\Chrome\\User Data",
  profileDirectory: process.env.CHROME_PROFILE_DIRECTORY ?? "sanchez",
  automationDataDir: process.env.LOCAL_BROWSER_DATA_DIR ??
    path.join(process.cwd(), ".local-browser-data"),
  headless: process.env.LOCAL_BROWSER_HEADLESS !== "false",
  idleTimeoutMs: parseInt(process.env.LOCAL_BROWSER_IDLE_TIMEOUT_MS ?? "300000", 10),
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

function syncProfileState(): void {
  const srcProfile = path.join(config.userDataDir, config.profileDirectory);
  const dstProfile = path.join(config.automationDataDir, config.profileDirectory);

  if (!fs.existsSync(srcProfile)) {
    log.warn({ srcProfile }, "Source Chrome profile not found — skipping sync");
    return;
  }

  fs.mkdirSync(dstProfile, { recursive: true });

  const dstMarker = path.join(dstProfile, ".synced");
  if (fs.existsSync(dstMarker)) {
    log.debug("Automation profile already synced — skipping copy");
    return;
  }

  log.info({ src: srcProfile, dst: dstProfile }, "Syncing Chrome profile for automation");

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
      // File may not exist in source profile
    }
  }

  // Copy Local Storage if present (for site-specific login tokens)
  const srcLs = path.join(srcProfile, "Local Storage");
  if (fs.existsSync(srcLs)) {
    fs.cpSync(srcLs, path.join(dstProfile, "Local Storage"), { recursive: true, force: true });
  }

  fs.writeFileSync(dstMarker, new Date().toISOString());
  log.info("Profile sync complete");
}

interface BrowserInstance {
  context: BrowserContext;
  activePagesCount: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let instance: BrowserInstance | null = null;
let launching = false;

export function getLocalBrowserConfig(): LocalBrowserConfig {
  return { ...config };
}

export function updateLocalBrowserConfig(partial: Partial<LocalBrowserConfig>): void {
  Object.assign(config, partial);
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
    syncProfileState();

    log.info({
      chromeExecutablePath: config.chromeExecutablePath,
      userDataDir: config.userDataDir,
      profileDirectory: config.profileDirectory,
      automationDataDir: config.automationDataDir,
      headless: config.headless,
    }, `Launching local persistent Chrome — profileDirectory=${config.profileDirectory}`);

    const context = await chromium.launchPersistentContext(
      config.automationDataDir,
      {
        executablePath: config.chromeExecutablePath,
        headless: config.headless,
        args: [
          `--profile-directory=${config.profileDirectory}`,
          "--no-first-run",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--disable-default-apps",
        ],
        viewport: { width: 1366, height: 768 },
        ignoreDefaultArgs: ["--enable-automation"],
      },
    );

    const inst: BrowserInstance = {
      context,
      activePagesCount: 0,
      lastActivityAt: Date.now(),
      idleTimer: null,
    };

    context.on("close", () => {
      log.info("Local browser closed");
      instance = null;
    });

    instance = inst;
    resetIdleTimer();
    log.info({
      chromeExecutablePath: config.chromeExecutablePath,
      userDataDir: config.userDataDir,
      profileDirectory: config.profileDirectory,
      automationDataDir: config.automationDataDir,
    }, `✓ Local persistent Chrome launched — profileDirectory=${config.profileDirectory}`);
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

export async function closeBrowser(): Promise<void> {
  if (!instance) return;
  const inst = instance;
  instance = null;
  if (inst.idleTimer) clearTimeout(inst.idleTimer);
  try {
    await inst.context.close();
  } catch (err) {
    log.warn({ err }, "Error closing local browser context");
  }
  log.info("Local browser process closed (profile preserved on disk)");
}

export async function destroyOnBreaker(source: string, failureType: FailureType): Promise<void> {
  log.warn({ source, failureType }, "Breaker-triggered destroy — stopping heartbeat, killing browser, preserving profile");

  // 1. Stop any running heartbeat for this source FIRST
  stopHeartbeat(source);

  // 2. Record failure (may trigger cooldown)
  await recordFailure(source, failureType, {
    maxFailures: config.breakerMaxFailures,
    cooldownMs: config.breakerCooldownMs,
  });

  // 3. Kill browser process (profile on disk preserved)
  await closeBrowser();

  log.info({ source, failureType }, "Breaker destroy complete: heartbeat stopped + browser closed + profile preserved");
}

/**
 * Force re-sync of profile state from user's real Chrome.
 * Deletes the .synced marker so next launch copies fresh cookies/login data.
 */
export function invalidateProfileSync(): void {
  const marker = path.join(config.automationDataDir, config.profileDirectory, ".synced");
  try { fs.unlinkSync(marker); } catch { /* ok */ }
  log.info("Profile sync invalidated — will re-copy on next launch");
}

export interface PageSession {
  page: Page;
  close: () => Promise<void>;
}

export async function createPage(source: string): Promise<PageSession> {
  const inCooldown = await isSourceInCooldown(source);
  if (inCooldown) {
    throw new Error(`Source ${source} is in circuit breaker cooldown`);
  }

  const inst = await launchBrowser();
  const page = await inst.context.newPage();
  inst.activePagesCount++;
  inst.lastActivityAt = Date.now();

  log.debug({ source, activePages: inst.activePagesCount }, "Created new page");

  const close = async () => {
    try {
      if (!page.isClosed()) await page.close();
    } catch { /* already closed */ }
    if (instance) {
      instance.activePagesCount = Math.max(0, instance.activePagesCount - 1);
      instance.lastActivityAt = Date.now();
      resetIdleTimer();
      log.debug({ source, activePages: instance.activePagesCount }, "Page closed");
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

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Per-source heartbeat registry: allows destroyOnBreaker to cancel an active
 * heartbeat timer even from outside the withSourceLease scope.
 * Map<source, intervalId>
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
  const heartbeat = setInterval(async () => {
    try {
      const ok = await extendLease(source, holder, ttlMs);
      if (ok) {
        log.debug({ source, holder }, "Lease heartbeat — extended");
      } else {
        log.warn({ source, holder }, "Lease heartbeat — extension failed (lease may have been stolen)");
      }
    } catch (err) {
      log.warn({ source, holder, err }, "Lease heartbeat error");
    }
  }, HEARTBEAT_INTERVAL_MS);
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
