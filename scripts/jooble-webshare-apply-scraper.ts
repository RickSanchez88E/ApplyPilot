/**
 * Per-proxy persistent-context Jooble /desc/ apply-URL scraper.
 *
 * Each Webshare proxy (+ optional direct) gets its own `launchPersistentContext`
 * (real Chrome binary, separate --user-data-dir, cf_clearance bound to that IP).
 * This follows the cf-bypass-scraper skill:  persistent session ➜ CF auto-passes.
 *
 * Minimal bandwidth: images/css/font/media blocked; page.content() not called;
 * only apply-link heuristics run in-page.
 *
 * Usage:
 *   npx tsx scripts/jooble-webshare-apply-scraper.ts "https://jooble.org/desc/..." ["https://..."]
 *   npx tsx scripts/jooble-webshare-apply-scraper.ts --direct-only "https://jooble.org/desc/..."
 *   JOOBLE_DESC_URLS="url1,url2" npx tsx scripts/jooble-webshare-apply-scraper.ts
 *
 * Env:
 *   WEBSHARE_API_KEY           — required (unless --direct-only)
 *   WEBSHARE_PROXY_COUNT       — default 3
 *   WEBSHARE_PROXY_LIST_MODE   — default backbone
 *   JOOBLE_DESC_URLS           — comma-separated fallback list
 */
import "dotenv/config";
import * as path from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { listWebshareBrowserProxies, type BrowserProxyConfig } from "../src/lib/webshare.js";
import { isCfBlocked } from "../src/lib/cdp-pool.js";
import {
  attachMinimalBandwidthRoutes,
  isExternalEmployerApplyUrl,
  extractApplyOnlyFromLoadedPage,
} from "../src/sources/jooble-browser.js";
import { getConfig } from "../src/shared/config.js";
import { createChildLogger } from "../src/lib/logger.js";

const log = createChildLogger({ module: "webshare-apply-scraper" });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const PROFILE_ROOT = path.join(process.cwd(), ".cdp-profiles-proxy");

interface WorkerCtx {
  label: string;
  ctx: BrowserContext;
  page: Page;
  warm: boolean;
}

// ---------------------------------------------------------------------------
// Launch one persistent context (real Chrome, unique profile per proxy IP)
// ---------------------------------------------------------------------------
async function launchWorker(
  label: string,
  proxy?: { server: string; username?: string; password?: string },
): Promise<WorkerCtx> {
  const profileDir = path.join(PROFILE_ROOT, label.replace(/[^a-z0-9_-]/gi, "_"));

  const headless = getConfig().browserHeadless;
  log.info({ label, proxy: proxy?.server ?? "direct", profileDir, headless }, "Launching persistent context…");

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    channel: "chrome",
    proxy: proxy ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
    ],
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    locale: "en-GB",
    timezoneId: "Europe/London",
    ignoreDefaultArgs: ["--enable-automation"],
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await ctx.newPage();
  await attachMinimalBandwidthRoutes(page);

  return { label, ctx, page, warm: false };
}

// ---------------------------------------------------------------------------
// Warmup: two-phase — first the homepage, then a /desc/ page (which has
// stricter CF). cf_clearance issued on /desc/ challenge is domain-wide,
// so subsequent /desc/ pages reuse the cookie.
// ---------------------------------------------------------------------------

/**
 * Try to click the Turnstile checkbox inside the CF challenge iframe.
 * Returns true if we found and clicked something.
 */
async function tryClickTurnstile(page: Page, label: string): Promise<boolean> {
  try {
    // Turnstile lives in an iframe from challenges.cloudflare.com
    const frame = page.frames().find((f) =>
      /challenges\.cloudflare\.com|turnstile/i.test(f.url()),
    );
    if (!frame) {
      // Fallback: look for the iframe element and its contentFrame
      const iframeEl = await page.$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
      if (iframeEl) {
        const cf = await iframeEl.contentFrame();
        if (cf) {
          const checkbox = await cf.$('input[type="checkbox"], .cb-lb, .ctp-checkbox-label, [id*="challenge"]');
          if (checkbox) {
            await checkbox.click({ force: true });
            log.info({ label }, "Clicked Turnstile checkbox (via contentFrame)");
            return true;
          }
        }
      }

      // Try clicking the Turnstile wrapper div on the main page (non-iframe variant)
      const wrapper = await page.$('#turnstile-wrapper input, .cf-turnstile input, [data-sitekey] input');
      if (wrapper) {
        await wrapper.click({ force: true });
        log.info({ label }, "Clicked Turnstile input on main page");
        return true;
      }
      return false;
    }

    // Found the frame directly — try multiple selectors
    for (const sel of [
      'input[type="checkbox"]',
      ".cb-lb",
      ".ctp-checkbox-label",
      "label",
      "body",
    ]) {
      const el = await frame.$(sel);
      if (el) {
        await el.click({ force: true });
        log.info({ label, selector: sel }, "Clicked Turnstile element in CF iframe");
        return true;
      }
    }
    return false;
  } catch (err) {
    log.debug({ err, label }, "Turnstile click attempt failed (non-fatal)");
    return false;
  }
}

/** Wait loop: check title every `interval` ms, up to `total` ms. Try clicking Turnstile. */
async function waitForCfPass(page: Page, label: string, totalMs: number, intervalMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  let clickAttempted = false;
  while (Date.now() < deadline) {
    const remaining = Math.min(intervalMs, deadline - Date.now());
    if (remaining <= 0) break;
    await page.waitForTimeout(remaining);

    const t = await page.title();
    if (!isCfBlocked(t)) return true;

    // Try clicking Turnstile after a few seconds (give it time to render)
    if (!clickAttempted) {
      clickAttempted = await tryClickTurnstile(page, label);
      if (clickAttempted) {
        await page.waitForTimeout(3_000);
        if (!isCfBlocked(await page.title())) return true;
      }
    }

    log.info({ label, remainMs: deadline - Date.now() }, "Still CF challenge, polling…");
  }
  return !isCfBlocked(await page.title());
}

/**
 * Three-phase warmup that mimics real user browsing (homepage → search → /desc/).
 * Jooble sets session cookies progressively; /desc/ pages fail if you skip the
 * search-results step. Each persistent context has its own cookie jar per proxy IP.
 */
async function warmup(w: WorkerCtx, descUrls: string[]): Promise<boolean> {
  const t0 = Date.now();
  try {
    // Phase 1: homepage — sets initial __cf_bm + session cookies
    log.info({ label: w.label }, "Phase 1/3: homepage");
    await w.page.goto("https://jooble.org", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await w.page.waitForTimeout(2_000);
    let title = await w.page.title();
    if (isCfBlocked(title)) {
      log.info({ label: w.label }, "CF on homepage, waiting up to 30 s…");
      if (!(await waitForCfPass(w.page, w.label, 30_000))) {
        log.warn({ label: w.label }, "Homepage CF stuck — aborting warmup");
        return false;
      }
    }

    // Phase 2: search results — accumulates further session state
    log.info({ label: w.label }, "Phase 2/3: search results page");
    await w.page.goto(
      "https://jooble.org/SearchResult?rgns=United%20Kingdom&ukw=software+engineer",
      { waitUntil: "domcontentloaded", timeout: 30_000, referer: "https://jooble.org/" },
    );
    await w.page.waitForTimeout(3_000);
    title = await w.page.title();
    if (isCfBlocked(title)) {
      log.info({ label: w.label }, "CF on search page, waiting up to 35 s…");
      if (!(await waitForCfPass(w.page, w.label, 35_000))) {
        log.warn({ label: w.label }, "Search page CF stuck — aborting warmup");
        return false;
      }
    }
    log.info({ label: w.label, title: (await w.page.title()).slice(0, 80) }, "Search page loaded");

    // Phase 3: navigate to /desc/ via window.location (same-origin navigation,
    // sends proper Sec-Fetch-Site/Mode/Dest headers that CF expects)
    const warmupDescUrl = descUrls[0] ?? "https://jooble.org/desc/-1";
    log.info({ label: w.label, url: warmupDescUrl.slice(0, 80) }, "Phase 3/3: /desc/ via window.location");
    await w.page.evaluate((url) => { window.location.href = url; }, warmupDescUrl);
    await w.page.waitForLoadState("domcontentloaded").catch(() => {});
    await w.page.waitForTimeout(2_000);
    title = await w.page.title();

    if (isCfBlocked(title)) {
      log.info({ label: w.label }, "CF on /desc/, waiting up to 45 s…");
      if (!(await waitForCfPass(w.page, w.label, 45_000))) {
        w.warm = false;
        log.warn({ label: w.label, ms: Date.now() - t0, title: await w.page.title() }, "Warmup FAILED on /desc/");
        return false;
      }
    }

    // Check for "invalid response" / Chrome error page (title is "Just a moment..."
    // but body says "sent an invalid response")
    const bodyText = await w.page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "").catch(() => "");
    if (/sent an invalid response|ERR_EMPTY_RESPONSE/i.test(bodyText)) {
      log.warn({ label: w.label, bodyText: bodyText.slice(0, 120) }, "/desc/ returned invalid response — job may be expired, trying a different URL");
      // This specific /desc/ URL is dead; the session itself is OK. Mark warm.
      w.warm = true;
      log.info({ label: w.label, ms: Date.now() - t0 }, "Warmup OK (session cookies set, first /desc/ URL invalid)");
      return true;
    }

    w.warm = true;
    log.info({ label: w.label, ms: Date.now() - t0 }, "Warmup OK — /desc/ loaded successfully");
    return true;
  } catch (err) {
    log.error({ err, label: w.label }, "Warmup exception");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Navigate via window.location (same-origin, sends proper Sec-Fetch-* headers)
// then extract apply URL from the loaded DOM.
// ---------------------------------------------------------------------------
async function navigateSameOrigin(page: Page, url: string, timeoutMs = 30_000): Promise<{ title: string; blocked: boolean }> {
  await page.evaluate((u) => { window.location.href = u; }, url);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1_500);
  const title = await page.title();
  let blocked = isCfBlocked(title);
  if (blocked) {
    log.info({ url: url.slice(0, 60) }, "CF on /desc/, waiting 15 s…");
    await page.waitForTimeout(15_000);
    blocked = isCfBlocked(await page.title());
    if (blocked) {
      log.warn({ url: url.slice(0, 60) }, "CF still blocking after 15 s, waiting 20 s more…");
      await page.waitForTimeout(20_000);
      blocked = isCfBlocked(await page.title());
    }
  }
  return { title: await page.title(), blocked };
}

async function scrapeOne(
  w: WorkerCtx,
  descUrl: string,
): Promise<{
  label: string;
  url: string;
  ok: boolean;
  applyUrl: string | null;
  accepted: boolean;
  reason?: string;
  ms: number;
}> {
  const t0 = Date.now();
  try {
    const { blocked } = await navigateSameOrigin(w.page, descUrl);
    if (blocked) {
      return { label: w.label, url: descUrl, ok: false, applyUrl: null, accepted: false, reason: "cf_blocked", ms: Date.now() - t0 };
    }

    // Jooble Apply buttons link to /away/{id}?... which JS-redirects to the employer.
    // Find the first /away/ link, open in new tab, wait for redirect.
    const awayHref = await w.page.evaluate(() => {
      for (const a of document.querySelectorAll("a[href*='/away/']")) {
        const text = (a.textContent || "").trim();
        if (/^apply/i.test(text)) return a.getAttribute("href") || "";
      }
      return "";
    });

    let employerApplyUrl: string | null = null;
    if (awayHref) {
      try {
        const newPage = await w.ctx.newPage();
        await attachMinimalBandwidthRoutes(newPage);
        await newPage.goto(awayHref, { waitUntil: "commit", timeout: 15_000 }).catch(() => {});
        // Wait up to 10s for the URL to leave jooble.org
        try {
          await newPage.waitForURL((u) => !u.toString().includes("jooble.org"), { timeout: 10_000 });
        } catch { /* timeout OK — check URL anyway */ }
        const finalUrl = newPage.url();
        await newPage.close().catch(() => {});
        if (finalUrl && !/jooble\./i.test(finalUrl) && finalUrl.startsWith("http")) {
          employerApplyUrl = finalUrl;
          log.info({ finalUrl: finalUrl.slice(0, 120) }, "/away/ redirected → employer URL");
        } else {
          log.info({ awayUrl: awayHref.slice(0, 80), finalUrl: finalUrl?.slice(0, 80) }, "/away/ redirect didn't leave Jooble");
        }
      } catch (err) {
        log.warn({ err, awayUrl: awayHref.slice(0, 80) }, "/away/ redirect failed");
      }
    }

    // Fallback: try the original heuristic extraction
    if (!employerApplyUrl) {
      const outcome = await extractApplyOnlyFromLoadedPage(w.page, descUrl);
      if (outcome.ok && outcome.detail.applyUrl) {
        employerApplyUrl = outcome.detail.applyUrl;
      }
    }

    const outcome = { ok: true, detail: { applyUrl: employerApplyUrl || "" } } as const;
    if (!outcome.ok) {
      return { label: w.label, url: descUrl, ok: false, applyUrl: null, accepted: false, reason: outcome.reason, ms: Date.now() - t0 };
    }

    const raw = outcome.detail.applyUrl || null;
    const accepted = raw ? isExternalEmployerApplyUrl(raw) : false;
    return { label: w.label, url: descUrl, ok: true, applyUrl: raw, accepted, ms: Date.now() - t0 };
  } catch (err) {
    return {
      label: w.label,
      url: descUrl,
      ok: false,
      applyUrl: null,
      accepted: false,
      reason: err instanceof Error ? err.message : String(err),
      ms: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------------------
// Parse URLs from argv / env
// ---------------------------------------------------------------------------
function parseUrls(): string[] {
  const fromArgv = process.argv.slice(2).filter((a) => a.includes("/desc/") && a.startsWith("http"));
  if (fromArgv.length > 0) return fromArgv;

  const fromEnv = process.env.JOOBLE_DESC_URLS?.split(",").map((s) => s.trim()).filter((s) => s.startsWith("http"));
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const urls = parseUrls();
  if (urls.length === 0) {
    console.error(
      'Pass one or more Jooble /desc/ URLs as argv or set JOOBLE_DESC_URLS.\n' +
      'Example: npx tsx scripts/jooble-webshare-apply-scraper.ts "https://jooble.org/desc/-123456"',
    );
    process.exit(1);
  }

  const directOnly = process.argv.includes("--direct-only");
  const proxyCount = directOnly ? 0 : Number(process.env.WEBSHARE_PROXY_COUNT || "3");

  // Fetch proxy list
  let proxies: BrowserProxyConfig[] = [];
  if (proxyCount > 0) {
    proxies = await listWebshareBrowserProxies(proxyCount);
    if (proxies.length === 0) {
      log.warn("No Webshare proxies returned — falling back to direct only");
    }
  }

  // Build worker configs: 1 direct + N proxied
  const workerConfigs: { label: string; proxy?: BrowserProxyConfig }[] = [
    { label: "direct" },
    ...proxies.map((p, i) => ({ label: `proxy-${i}`, proxy: p })),
  ];

  log.info(
    { workers: workerConfigs.length, urls: urls.length, proxyServers: proxies.map((p) => p.server) },
    "Launching persistent contexts (real Chrome, per-IP cf_clearance)",
  );

  // Launch all workers in parallel
  const workers: WorkerCtx[] = [];
  const launchResults = await Promise.allSettled(
    workerConfigs.map((wc) => launchWorker(wc.label, wc.proxy)),
  );
  for (const r of launchResults) {
    if (r.status === "fulfilled") workers.push(r.value);
    else log.error({ err: r.reason }, "Worker launch failed");
  }

  if (workers.length === 0) {
    console.error("All workers failed to launch");
    process.exit(1);
  }

  // Warmup all workers in parallel (pass URLs so phase-2 can warm on a real /desc/)
  const warmResults = await Promise.allSettled(workers.map((w) => warmup(w, urls)));
  const readyWorkers = workers.filter((_, i) => {
    const r = warmResults[i];
    return r?.status === "fulfilled" && r.value;
  });

  log.info(
    { total: workers.length, ready: readyWorkers.length, failed: workers.length - readyWorkers.length },
    "Warmup complete",
  );

  if (readyWorkers.length === 0) {
    console.error("All workers failed CF warmup — cannot scrape");
    // Still clean up
    for (const w of workers) await w.ctx.close().catch(() => {});
    process.exit(1);
  }

  // Round-robin URLs across ready workers, sequential per worker
  const results: Awaited<ReturnType<typeof scrapeOne>>[] = [];
  for (let i = 0; i < urls.length; i++) {
    const w = readyWorkers[i % readyWorkers.length]!;
    const result = await scrapeOne(w, urls[i]!);
    results.push(result);

    const status = result.ok
      ? result.accepted ? `✓ ${result.applyUrl}` : `parsed but filtered: ${result.applyUrl}`
      : `✗ ${result.reason}`;
    log.info({ i, label: result.label, ms: result.ms }, status);
  }

  // Summary
  console.log("\n=== Results ===\n");
  console.log(JSON.stringify(results, null, 2));

  const accepted = results.filter((r) => r.accepted);
  const cfBlocked = results.filter((r) => r.reason === "cf_blocked");
  console.log(
    `\nTotal: ${results.length} | OK+accepted: ${accepted.length} | CF blocked: ${cfBlocked.length} | Other fail: ${results.length - accepted.length - cfBlocked.length}`,
  );

  if (accepted.length > 0) {
    console.log("\n--- 可用的雇主申请链 ---");
    for (const r of accepted) {
      console.log(`  ${r.label}: ${r.applyUrl}`);
    }
  }

  // Cleanup
  for (const w of workers) {
    await w.page.close().catch(() => {});
    await w.ctx.close().catch(() => {});
  }
}

main().catch((e) => {
  log.error({ e }, "Fatal");
  console.error(e);
  process.exit(1);
});
