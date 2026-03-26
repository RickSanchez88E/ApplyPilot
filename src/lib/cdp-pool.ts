/**
 * CDP Browser Pool — manages a headless Chrome instance for CF-protected scraping.
 *
 * Architecture:
 *   - Launches Chrome with --headless=new + separate --user-data-dir
 *   - Does NOT interfere with user's daily Chrome (completely isolated instance)
 *   - Chrome stays alive across requests (cookies persist, CF session maintained)
 *   - Auto-restarts if Chrome crashes or cookies expire
 *
 * Lifecycle:
 *   - cf_clearance cookie: issued by CF after JS challenge pass, TTL ~30min–2h
 *   - Because Chrome stays running, it auto-renews cookies on each page load
 *   - Session is effectively permanent as long as the Chrome process lives
 *   - If Chrome is killed, next request auto-launches a new instance
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import * as path from "path";
import * as os from "os";

const log = createChildLogger({ module: "cdp-pool" });

// Separate Chrome profile — never touches user's real Chrome
const CDP_PROFILE_DIR = path.join(os.tmpdir(), "cdp-scraper-profile");
const CDP_PORT = 9333; // Different from 9222 to avoid conflicts

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _launchPromise: Promise<void> | null = null;

/**
 * Get or launch the headless Chrome instance.
 * Safe to call multiple times — only one Chrome is ever running.
 */
export async function getCdpContext(): Promise<BrowserContext> {
  if (_context && _browser?.isConnected()) {
    return _context;
  }

  // Prevent parallel launches
  if (_launchPromise) {
    await _launchPromise;
    if (_context) return _context;
  }

  _launchPromise = launchChrome();
  await _launchPromise;
  _launchPromise = null;

  if (!_context) {
    throw new Error("Failed to launch CDP Chrome");
  }
  return _context;
}

async function launchChrome(): Promise<void> {
  log.info("Launching headless Chrome for CDP scraping...");

  try {
    // Use persistent context = cookies survive across navigations
    _context = await chromium.launchPersistentContext(CDP_PROFILE_DIR, {
      headless: true,
      channel: "chrome", // Use system Chrome for best fingerprint
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        `--remote-debugging-port=${CDP_PORT}`,
      ],
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "en-GB",
      timezoneId: "Europe/London",
      ignoreDefaultArgs: ["--enable-automation"],
    });

    // Patch webdriver on every new page
    await _context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    _browser = (_context as any)._browser ?? null;
    log.info({ profileDir: CDP_PROFILE_DIR }, "Headless Chrome launched successfully");
  } catch (err) {
    log.error({ err }, "Failed to launch Chrome");
    _context = null;
    _browser = null;
    throw err;
  }
}

/**
 * Navigate to a URL and return the page. Handles CF challenge with retry.
 */
export async function navigateWithCf(
  url: string,
  options?: { referer?: string; timeoutMs?: number },
): Promise<{ page: Page; html: string; title: string; blocked: boolean }> {
  const ctx = await getCdpContext();
  const page = await ctx.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options?.timeoutMs ?? 20_000,
      referer: options?.referer,
    });
    await page.waitForTimeout(3000);

    let title = await page.title();
    let html = await page.content();
    let blocked = /just a moment|checking your browser|performing security/i.test(title);

    if (blocked) {
      // Wait for CF challenge to resolve (up to 15s)
      log.info({ url: url.slice(0, 80) }, "CF challenge detected, waiting...");
      await page.waitForTimeout(15_000);
      title = await page.title();
      html = await page.content();
      blocked = /just a moment|checking your browser|performing security/i.test(title);
    }

    return { page, html, title, blocked };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
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
    _browser = null;
    log.info("CDP Chrome pool closed");
  }
}
