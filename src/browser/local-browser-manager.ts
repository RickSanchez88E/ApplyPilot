import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import { recordFailure, recordSuccess, isSourceInCooldown, type FailureType } from "./circuit-breaker.js";
import { acquireLease, releaseLease } from "../scheduler/source-lease.js";

const log = createChildLogger({ module: "local-browser-mgr" });

export interface LocalBrowserConfig {
  chromeExecutablePath: string;
  userDataDir: string;
  profileDirectory: string;
  headless: boolean;
  idleTimeoutMs: number;
  breakerMaxFailures: number;
  breakerCooldownMs: number;
}

const DEFAULT_CONFIG: LocalBrowserConfig = {
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  userDataDir: process.env.CHROME_USER_DATA_DIR ?? "C:\\Users\\rick\\AppData\\Local\\Google\\Chrome\\User Data",
  profileDirectory: process.env.CHROME_PROFILE_DIRECTORY ?? "Default",
  headless: process.env.LOCAL_BROWSER_HEADLESS !== "false",
  idleTimeoutMs: parseInt(process.env.LOCAL_BROWSER_IDLE_TIMEOUT_MS ?? "300000", 10),
  breakerMaxFailures: parseInt(process.env.BREAKER_MAX_FAILURES ?? "3", 10),
  breakerCooldownMs: parseInt(process.env.BREAKER_COOLDOWN_MS ?? "1800000", 10),
};

interface BrowserInstance {
  browser: Browser;
  context: BrowserContext;
  activePagesCount: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let instance: BrowserInstance | null = null;
let launching = false;
const config = DEFAULT_CONFIG;

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
    log.info({
      executable: config.chromeExecutablePath,
      profileDir: config.profileDirectory,
      headless: config.headless,
    }, "Launching local persistent Chrome");

    const browser = await chromium.launchPersistentContext(
      `${config.userDataDir}\\${config.profileDirectory}`,
      {
        executablePath: config.chromeExecutablePath,
        headless: config.headless,
        args: [
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
      browser: browser as unknown as Browser,
      context: browser,
      activePagesCount: 0,
      lastActivityAt: Date.now(),
      idleTimer: null,
    };

    browser.on("close", () => {
      log.info("Local browser closed");
      instance = null;
    });

    instance = inst;
    resetIdleTimer();
    log.info("Local persistent Chrome launched successfully");
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
  log.info("Local browser process closed (profile preserved)");
}

export async function destroyOnBreaker(source: string, failureType: FailureType): Promise<void> {
  log.warn({ source, failureType }, "Breaker-triggered destroy — killing browser process, preserving profile");
  await recordFailure(source, failureType, {
    maxFailures: config.breakerMaxFailures,
    cooldownMs: config.breakerCooldownMs,
  });
  await closeBrowser();
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

export async function withSourceLease<T>(
  source: string,
  holder: string,
  fn: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const lease = await acquireLease(source, holder, ttlMs);
  if (!lease) {
    throw new Error(`Cannot acquire lease for source ${source} — another task is running`);
  }
  try {
    return await fn();
  } finally {
    await releaseLease(source, holder);
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
