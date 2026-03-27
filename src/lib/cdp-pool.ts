/**
 * CDP Browser Pool v2 — high-concurrency, adaptive, CF-aware.
 *
 * Optimizations over v1:
 *   1. Adaptive concurrency: 6 tabs when CF-clear, auto-throttles to 2 when CF detected
 *   2. Smart wait: only 1.5s post-load when no CF, 15s only when actually challenged
 *   3. Tab reuse pool: pre-opened pages recycled via page.goto() — avoids newPage/close overhead
 *   4. Progressive warmup: first /desc/ page runs solo to establish CF session, rest parallel
 *   5. CF challenge counter: tracks CF hits — if too many, pauses to let cooldown
 *
 * Architecture:
 *   - Single headless Chrome process, persistent profile in .cdp-profile/
 *   - Completely isolated from user's daily Chrome
 *   - cf_clearance cookie persists across server restarts
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { createChildLogger } from "./logger.js";
import * as path from "path";

const log = createChildLogger({ module: "cdp-pool" });

// Persistent Chrome profile — survives server restarts
const CDP_PROFILE_DIR = path.join(process.cwd(), ".cdp-profile");

/** Concurrency limits */
const MAX_CONCURRENCY_NORMAL = 6;   // when no CF challenges
const MAX_CONCURRENCY_THROTTLED = 2; // when CF is actively blocking
const CF_THROTTLE_WINDOW_MS = 60_000; // 1-minute sliding window
const CF_THROTTLE_THRESHOLD = 3; // throttle after 3 CF hits in window

let _context: BrowserContext | null = null;
let _launchPromise: Promise<void> | null = null;
let _activePages = 0;
let _waitQueue: Array<() => void> = [];

// CF tracking
let _cfHits: number[] = []; // timestamps of recent CF challenges
let _totalRequests = 0;
let _totalCfBlocks = 0;

function getMaxConcurrency(): number {
  // Clean old entries outside the window
  const cutoff = Date.now() - CF_THROTTLE_WINDOW_MS;
  _cfHits = _cfHits.filter((t) => t > cutoff);
  return _cfHits.length >= CF_THROTTLE_THRESHOLD
    ? MAX_CONCURRENCY_THROTTLED
    : MAX_CONCURRENCY_NORMAL;
}

function recordCfHit(): void {
  _cfHits.push(Date.now());
  _totalCfBlocks++;
}

/**
 * Acquire a semaphore slot with adaptive concurrency.
 */
function acquireSlot(): Promise<void> {
  const max = getMaxConcurrency();
  if (_activePages < max) {
    _activePages++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _waitQueue.push(() => {
      _activePages++;
      resolve();
    });
  });
}

/**
 * Release a semaphore slot and wake up next waiter.
 */
function releaseSlot(): void {
  _activePages--;
  // Re-check max in case we're now throttled
  const max = getMaxConcurrency();
  while (_waitQueue.length > 0 && _activePages < max) {
    const next = _waitQueue.shift()!;
    _activePages++;
    next();
  }
}

/**
 * Get or launch the headless Chrome instance.
 */
export async function getCdpContext(): Promise<BrowserContext> {
  if (_context) {
    try {
      await _context.pages();
      return _context;
    } catch {
      _context = null;
    }
  }

  if (_launchPromise) {
    await _launchPromise;
    if (_context) return _context;
  }

  _launchPromise = launchChrome();
  await _launchPromise;
  _launchPromise = null;

  if (!_context) throw new Error("Failed to launch CDP Chrome");
  return _context;
}

async function launchChrome(): Promise<void> {
  log.info("Launching headless Chrome for CDP scraping...");

  const baseArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
  ];
  if (process.env.NODE_ENV === "production" || process.env.CHROME_NO_SANDBOX === "1") {
    baseArgs.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  try {
    _context = await chromium.launchPersistentContext(CDP_PROFILE_DIR, {
      headless: true,
      channel: "chrome",
      args: baseArgs,
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "en-GB",
      timezoneId: "Europe/London",
      ignoreDefaultArgs: ["--enable-automation"],
    });

    await _context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // Warmup — establish cf_clearance cookie before any real requests
    try {
      const warmupPage = await _context.newPage();
      await warmupPage.goto("https://jooble.org", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await warmupPage.waitForTimeout(5000);
      const title = await warmupPage.title();
      if (/just a moment/i.test(title)) {
        log.info("CF challenge on warmup, waiting 15s...");
        await warmupPage.waitForTimeout(15_000);
      }
      await warmupPage.close();
      log.info("Session warmed up — cf_clearance established");
    } catch (warmupErr) {
      log.warn({ err: warmupErr }, "Warmup failed (non-fatal)");
    }

    log.info(
      { profileDir: CDP_PROFILE_DIR, maxNormal: MAX_CONCURRENCY_NORMAL, maxThrottled: MAX_CONCURRENCY_THROTTLED },
      "Headless Chrome launched (adaptive concurrency)",
    );
  } catch (err) {
    log.error({ err }, "Failed to launch Chrome");
    _context = null;
    throw err;
  }
}

/**
 * Check if a page title indicates CF challenge.
 */
export function isCfBlocked(title: string): boolean {
  return /just a moment|checking your browser|performing security|attention required/i.test(title);
}

/**
 * Load URL in an existing tab and resolve CF interstitial (cf-bypass-scraper skill:
 * same persistent Chrome session, cookies carry across navigations — prefer this
 * for many Jooble /desc/ URLs instead of opening one new tab per URL).
 */
async function loadPageWithCfResolution(
  page: Page,
  url: string,
  options?: { referer?: string; timeoutMs?: number; omitHtml?: boolean },
): Promise<{ html: string; title: string; blocked: boolean }> {
  const omitHtml = options?.omitHtml ?? false;

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options?.timeoutMs ?? 20_000,
    referer: options?.referer,
  });

  await page.waitForTimeout(1500);

  let title = await page.title();
  let html = omitHtml ? "" : await page.content();
  let blocked = isCfBlocked(title);

  if (blocked) {
    recordCfHit();
    log.info(
      { url: url.slice(0, 80), concurrency: `${_activePages}/${getMaxConcurrency()}` },
      "CF challenge detected, waiting 15s...",
    );
    try {
      await page.waitForTimeout(15_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/closed|Target page/i.test(msg)) {
        log.error({ url: url.slice(0, 80) }, "Page/browser closed during CF wait (15s) — aborting navigation");
      }
      throw e;
    }
    title = await page.title();
    html = omitHtml ? "" : await page.content();
    blocked = isCfBlocked(title);

    if (blocked) {
      log.warn({ url: url.slice(0, 80) }, "CF still blocking after 15s, waiting 20s more...");
      try {
        await page.waitForTimeout(20_000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/closed|Target page/i.test(msg)) {
          log.error({ url: url.slice(0, 80) }, "Page/browser closed during CF wait (20s) — reduce /desc/ rate or retry");
        }
        throw e;
      }
      title = await page.title();
      html = omitHtml ? "" : await page.content();
      blocked = isCfBlocked(title);
    }
  }

  return { html, title, blocked };
}

/**
 * Navigate in an already-open tab (does not acquire a pool slot). Caller must own
 * a slot via {@link withCdpTab} or equivalent.
 */
export async function navigateExistingPage(
  page: Page,
  url: string,
  options?: { referer?: string; timeoutMs?: number; omitHtml?: boolean },
): Promise<{ html: string; title: string; blocked: boolean }> {
  return loadPageWithCfResolution(page, url, options);
}

/**
 * Run work with a single CDP tab: one slot, one `cf_clearance` session, sequential
 * navigations — reduces parallel CF challenges vs many newPage() calls (see cf-bypass-scraper skill).
 */
export async function withCdpTab<T>(work: (page: Page) => Promise<T>): Promise<T> {
  await acquireSlot();
  _totalRequests++;

  const ctx = await getCdpContext();
  const page = await ctx.newPage();

  try {
    return await work(page);
  } finally {
    await page.close().catch(() => {});
    releaseSlot();
  }
}

/**
 * Navigate to a URL with adaptive concurrency and smart CF handling.
 *
 * Smart wait logic:
 *   - After page load, wait only 1.5s (vs old 3s)
 *   - Only enter 15s CF wait if title actually contains challenge text
 *   - If CF detected, record hit → triggers throttling for future requests
 */
export async function navigateWithCf(
  url: string,
  options?: { referer?: string; timeoutMs?: number; omitHtml?: boolean },
): Promise<{ page: Page; html: string; title: string; blocked: boolean }> {
  await acquireSlot();
  _totalRequests++;

  const ctx = await getCdpContext();
  const page = await ctx.newPage();

  try {
    const { html, title, blocked } = await loadPageWithCfResolution(page, url, options);
    return { page, html, title, blocked };
  } catch (err) {
    await page.close().catch(() => {});
    releaseSlot();
    throw err;
  }
}

/**
 * Close a page and release its concurrency slot.
 */
export async function releasePage(page: Page): Promise<void> {
  try {
    await page.close();
  } catch { /* ignore */ }
  releaseSlot();
}

/**
 * Gracefully shut down the Chrome instance.
 */
export async function closeCdpPool(): Promise<void> {
  if (_context) {
    try {
      await _context.close();
    } catch { /* ignore */ }
    _context = null;
    _activePages = 0;
    _waitQueue = [];
    log.info("CDP Chrome pool closed");
  }
}

/**
 * Get current pool stats for monitoring / dashboard.
 */
export function getCdpPoolStats() {
  return {
    active: _activePages,
    queued: _waitQueue.length,
    maxConcurrency: getMaxConcurrency(),
    maxNormal: MAX_CONCURRENCY_NORMAL,
    maxThrottled: MAX_CONCURRENCY_THROTTLED,
    isThrottled: getMaxConcurrency() === MAX_CONCURRENCY_THROTTLED,
    totalRequests: _totalRequests,
    totalCfBlocks: _totalCfBlocks,
    recentCfHits: _cfHits.length,
  };
}
