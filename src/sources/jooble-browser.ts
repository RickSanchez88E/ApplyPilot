/**
 * Jooble CDP Browser Scraper — search-page-first, then /desc/ for real apply URL.
 *
 * Stores `source_url` = canonical Jooble `/desc/...` (dedup / provenance).
 * Stores `apply_url` = employer ATS / careers page when found (not Jooble wrapper).
 *
 * Jooble detail pages expose the outbound apply link as a normal external <a>; `og:url`
 * is usually still Jooble — do not use it as apply URL.
 */
import {
  navigateExistingPage,
  navigateWithCf,
  releasePage,
  withCdpTab,
} from "../lib/cdp-pool.js";
import { chromium, type Page } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import { listWebshareBrowserProxies, type BrowserProxyConfig } from "../lib/webshare.js";
import { getConfig } from "../shared/config.js";
import { appendLog } from "../lib/progress.js";

const log = createChildLogger({ module: "jooble-browser" });

/** Max Jooble /desc/ fetches per keyword (each fetch resolves apply URL + JD). */
function getMaxDescFetchesPerKeyword(): number {
  const raw = process.env.JOOBLE_MAX_DESC_FETCHES;
  const n = raw ? Number.parseInt(raw, 10) : 60;
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.min(n, 200);
}

/** Delay between /desc/ navigations to reduce CF throttling (ms). */
function getDescFetchDelayMs(): number {
  const raw = process.env.JOOBLE_DESC_FETCH_DELAY_MS;
  const n = raw ? Number.parseInt(raw, 10) : 1200;
  if (!Number.isFinite(n) || n < 0) return 1200;
  return Math.min(n, 30_000);
}

/** Jooble affiliate / quiz funnels — not employer ATS pages. */
function isJoobleAggregatorApplyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (/(^|\.)fitly\.work$/i.test(h)) return true;
    if (/quiz-onboarding|\/apply\/quiz/i.test(u.pathname + u.search)) return true;
    return false;
  } catch {
    return false;
  }
}

/** True if URL looks like an employer / third-party apply target (not Jooble). */
export function isExternalEmployerApplyUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false;
  const t = url.trim();
  if (!/^https?:\/\//i.test(t)) return false;
  if (isJoobleAggregatorApplyUrl(t)) return false;
  try {
    const host = new URL(t).hostname.toLowerCase();
    return !host.endsWith("jooble.org") && !host.endsWith("jooble.com");
  } catch {
    return false;
  }
}

export interface JoobleJobDetail {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly salary: string;
  readonly description: string;
  /** Employer / ATS apply URL when extracted; may be empty if not found. */
  readonly applyUrl: string;
  /** Always the Jooble `/desc/...` URL used for dedup + provenance. */
  readonly sourceUrl: string;
}

/** Data extracted directly from search result cards (no desc page needed) */
interface SearchCardData {
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;
  descUrl: string;
}

export type ScrapeJoobleDescOutcome =
  | { ok: true; detail: JoobleJobDetail }
  | { ok: false; expired: boolean; reason?: string };

// Script to extract job cards from search results page
const SEARCH_EXTRACT_SCRIPT = `(() => {
  // CF Challenge Detection — abort immediately if this is a challenge page
  var pageText = (document.title + " " + document.body.innerText.slice(0, 500)).toLowerCase();
  var cfPatterns = ["just a moment", "checking your browser", "cf-browser-verification",
    "attention required", "enable javascript", "ray id", "security check",
    "verifying you are human", "challenge-platform", "turnstile"];
  for (var p of cfPatterns) {
    if (pageText.includes(p)) return [];
  }

  var cards = [];
  var listItems = document.querySelectorAll('li');
  var seen = new Set();

  for (var li of listItems) {
    var link = li.querySelector('a[href*="/desc/"]');
    if (!link) continue;

    var href = link.href;
    var descId = href.match(/desc\\/([^?]+)/);
    var key = descId ? descId[1] : href;
    if (seen.has(key)) continue;
    seen.add(key);

    var h2 = li.querySelector('h2');
    var title = h2 ? h2.textContent.trim() : link.textContent.trim();

    var fullText = li.innerText || "";

    var snippet = "";
    var titlePos = fullText.indexOf(title);
    if (titlePos >= 0) {
      snippet = fullText.slice(titlePos + title.length).trim();
      snippet = snippet.replace(/^\\.{3}\\s*/, "").replace(/\\s+/g, " ").slice(0, 500);
    }

    var company = "";
    var location = "";

    var titleLocMatch = title.match(/^(.+?)\\s*[-–]\\s*((?:[A-Z][a-z]+(?:,\\s*)?)+(?:United Kingdom|UK|London|England|Scotland|Wales)?)$/);
    if (titleLocMatch) {
      title = titleLocMatch[1].trim();
      location = titleLocMatch[2].trim();
    }

    var salary = "";
    var salMatch = fullText.match(/([$£€][\\d,.]+(?:\\s*[-–]\\s*[$£€][\\d,.]+)?(?:\\s*(?:per|a)\\s+(?:hour|year|annum|month|day|week))?)/i);
    if (salMatch) salary = salMatch[0];

    cards.push({
      title: title.slice(0, 200),
      company: company,
      location: location,
      salary: salary,
      snippet: snippet || fullText.slice(0, 500),
      descUrl: href,
    });
  }

  return cards;
})()`;

/**
 * Extract JD + employer apply URL from /desc/ DOM.
 * Does NOT trust og:url when it points at jooble.org — real apply links are external <a href>.
 */
const DESC_EXTRACT_SCRIPT = `(() => {
  var head = (document.title + " " + (document.body.innerText || "").slice(0, 500)).toLowerCase();
  var cfPatterns = ["just a moment", "checking your browser", "cf-browser-verification",
    "attention required", "enable javascript", "ray id",
    "verifying you are human", "challenge-platform", "turnstile"];
  for (var p of cfPatterns) {
    if (head.includes(p)) return { expired: false, cfBlocked: true, applyUrl: "", title: "", company: "", location: "", salary: "", description: "" };
  }

  var bodyText = document.body.innerText || "";
  var expired = /the job position is no longer available|this job is no longer available|job is no longer available|position is no longer available|job position is no longer|this vacancy is no longer|listing has expired|job has been removed|vacancy has closed/i.test(bodyText);
  if (expired) {
    return { expired: true, cfBlocked: false, applyUrl: "", title: "", company: "", location: "", salary: "", description: "" };
  }

  function pickApplyUrl() {
    var best = "";
    var bestScore = -1;
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute("href");
      if (!href) continue;
      if (href.indexOf("mailto:") === 0 || href.indexOf("tel:") === 0 || href.indexOf("javascript:") === 0) continue;
      var abs = href;
      if (href.indexOf("//") === 0) abs = "https:" + href;
      else if (href.indexOf("http") !== 0) continue;

      var host = "";
      try { host = new URL(abs).hostname.toLowerCase(); } catch (e) { continue; }
      // Allow jooble.org/away/ links (redirect to employer); skip all other jooble links
      if (host.indexOf("jooble.") >= 0 && abs.indexOf("/away/") < 0) continue;
      if (host.indexOf("facebook.com") >= 0 || host.indexOf("twitter.com") >= 0 || host.indexOf("t.co") >= 0) continue;
      if (host.indexOf("linkedin.com") >= 0 && (abs.indexOf("/share") >= 0 || abs.indexOf("shareArticle") >= 0)) continue;
      if (host.indexOf("fitly.work") >= 0 || abs.indexOf("quiz-onboarding") >= 0) continue;

      var text = (a.textContent || "").trim().toLowerCase();
      var score = 0;
      if (abs.indexOf("/away/") >= 0) score += 50;
      if (abs.indexOf("utm_source=jooble") >= 0 || abs.indexOf("utm_medium=") >= 0) score += 25;
      if (/apply|apply now|apply for|bewerben|postuler|candidate portal|careers/i.test(text)) score += 45;
      var cls = ((a.className || "") + "").toLowerCase();
      var pe = a.parentElement;
      var pcls = pe ? ((pe.className || "") + "").toLowerCase() : "";
      if (cls.indexOf("apply") >= 0 || pcls.indexOf("apply") >= 0) score += 30;
      if (abs.indexOf("/jobs/") >= 0 || abs.indexOf("/job/") >= 0) score += 20;
      if (abs.indexOf("greenhouse.io") >= 0 || abs.indexOf("lever.co") >= 0 || abs.indexOf("ashbyhq.com") >= 0) score += 15;
      if (score > bestScore) {
        bestScore = score;
        best = abs;
      }
    }
    return best;
  }

  var applyUrl = pickApplyUrl();
  if (!applyUrl) {
    var og = document.querySelector('meta[property="og:url"]');
    if (og) {
      var ogH = og.getAttribute("content") || "";
      if (ogH && ogH.indexOf("jooble.") < 0 && ogH.indexOf("http") === 0) applyUrl = ogH;
    }
  }

  var h1 = document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : "";
  var company = "";
  var location = "";
  var salary = "";
  var description = "";
  var titleLine = "";

  var lines = bodyText.split("\\n").map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

  var copyrightIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/Jooble$/.test(lines[i]) && /\\d{4}/.test(lines[i])) { copyrightIdx = i; break; }
  }

  if (copyrightIdx >= 0 && copyrightIdx + 3 < lines.length) {
    var content = lines.slice(copyrightIdx + 1);
    titleLine = content[0] || "";
    var typeIdx = -1;
    for (var j = 0; j < Math.min(content.length, 5); j++) {
      if (/^(Full-time|Part-time|Contract|Temporary|Permanent|Freelance|Internship)/i.test(content[j])) {
        typeIdx = j; break;
      }
    }
    if (typeIdx >= 0 && typeIdx + 2 < content.length) {
      company = content[typeIdx + 1] || "";
      location = content[typeIdx + 2] || "";
    }
    var descStart = typeIdx >= 0 ? typeIdx + 3 : 2;
    description = content.slice(descStart).join("\\n").slice(0, 5000);
  }

  if (!description || description.length < 100) {
    if (h1) {
      var h1Pos = bodyText.indexOf(h1);
      if (h1Pos >= 0) description = bodyText.slice(h1Pos).slice(0, 5000);
    }
    if (!description || description.length < 100) {
      description = bodyText.slice(Math.max(0, bodyText.length - 5000));
    }
  }

  var salMatch = bodyText.match(/([$\\u00a3][\\d,.]+\\s*[-\\u2013]\\s*[$\\u00a3][\\d,.]+|[$\\u00a3][\\d,.]+\\s*per\\s+(hour|year|annum))/i);
  if (salMatch) salary = salMatch[0];

  return {
    expired: false,
    cfBlocked: false,
    applyUrl: applyUrl || "",
    title: h1 || titleLine || document.title.replace("Jooble - ", ""),
    company: company,
    location: location,
    salary: salary,
    description: description.slice(0, 5000),
  };
})()`;

/**
 * Bandwidth-minimal: same apply-link heuristics as full DESC script but no JD/company/salary text.
 * Used with resource blocking + omitHtml so Webshare/CDP does not pull full HTML to Node.
 */
const JOOBLE_APPLY_ONLY_SCRIPT = `(() => {
  var head = (document.title + " " + (document.body.innerText || "").slice(0, 500)).toLowerCase();
  var cfPatterns = ["just a moment", "checking your browser", "cf-browser-verification",
    "attention required", "enable javascript", "ray id",
    "verifying you are human", "challenge-platform", "turnstile"];
  for (var p of cfPatterns) {
    if (head.includes(p)) return { cfBlocked: true, expired: false, applyUrl: "", pageTitle: document.title };
  }
  var bodyText = document.body.innerText || "";
  var expired = /the job position is no longer available|this job is no longer available|job is no longer available|position is no longer available|job position is no longer|this vacancy is no longer|listing has expired|job has been removed|vacancy has closed/i.test(bodyText);
  if (expired) return { cfBlocked: false, expired: true, applyUrl: "", pageTitle: document.title };

  function pickApplyUrl() {
    var best = "";
    var bestScore = -1;
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute("href");
      if (!href) continue;
      if (href.indexOf("mailto:") === 0 || href.indexOf("tel:") === 0 || href.indexOf("javascript:") === 0) continue;
      var abs = href;
      if (href.indexOf("//") === 0) abs = "https:" + href;
      else if (href.indexOf("http") !== 0) continue;
      var host = "";
      try { host = new URL(abs).hostname.toLowerCase(); } catch (e) { continue; }
      if (host.indexOf("jooble.") >= 0 && abs.indexOf("/away/") < 0) continue;
      if (host.indexOf("facebook.com") >= 0 || host.indexOf("twitter.com") >= 0 || host.indexOf("t.co") >= 0) continue;
      if (host.indexOf("linkedin.com") >= 0 && (abs.indexOf("/share") >= 0 || abs.indexOf("shareArticle") >= 0)) continue;
      if (host.indexOf("fitly.work") >= 0 || abs.indexOf("quiz-onboarding") >= 0) continue;
      var text = (a.textContent || "").trim().toLowerCase();
      var score = 0;
      if (abs.indexOf("/away/") >= 0) score += 50;
      if (abs.indexOf("utm_source=jooble") >= 0 || abs.indexOf("utm_medium=") >= 0) score += 25;
      if (/apply|apply now|apply for|bewerben|postuler|candidate portal|careers/i.test(text)) score += 45;
      var cls = ((a.className || "") + "").toLowerCase();
      var pe = a.parentElement;
      var pcls = pe ? ((pe.className || "") + "").toLowerCase() : "";
      if (cls.indexOf("apply") >= 0 || pcls.indexOf("apply") >= 0) score += 30;
      if (abs.indexOf("/jobs/") >= 0 || abs.indexOf("/job/") >= 0) score += 20;
      if (abs.indexOf("greenhouse.io") >= 0 || abs.indexOf("lever.co") >= 0 || abs.indexOf("ashbyhq.com") >= 0) score += 15;
      if (score > bestScore) { bestScore = score; best = abs; }
    }
    return best;
  }

  var applyUrl = pickApplyUrl();
  if (!applyUrl) {
    var og = document.querySelector('meta[property="og:url"]');
    if (og) {
      var ogH = og.getAttribute("content") || "";
      if (ogH && ogH.indexOf("jooble.") < 0 && ogH.indexOf("http") === 0) applyUrl = ogH;
    }
  }
  return { cfBlocked: false, expired: false, applyUrl: applyUrl || "", pageTitle: document.title };
})()`;

/** Block heavy subresources (proxy billed by bandwidth). Document + scripts + XHR still load. */
export async function attachMinimalBandwidthRoutes(page: Page): Promise<void> {
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "stylesheet" || t === "font" || t === "media") {
      return route.abort();
    }
    return route.continue();
  });
}

const DESC_NAV_OPTS = {
  referer: "https://jooble.org/SearchResult",
  timeoutMs: 25_000,
} as const;

/**
 * If applyUrl is a jooble.org/away/ redirect, open it in a new tab inside the
 * same browser context and follow the JS redirect to get the employer URL.
 */
async function resolveAwayUrl(page: Page, applyUrl: string): Promise<string> {
  if (!applyUrl || !applyUrl.includes("/away/")) return applyUrl;

  const ctx = page.context();
  const newPage = await ctx.newPage();
  try {
    await newPage.goto(applyUrl, { waitUntil: "commit", timeout: 15_000 }).catch(() => {});
    try {
      await newPage.waitForURL((u) => !u.toString().includes("jooble.org"), { timeout: 10_000 });
    } catch { /* timeout OK */ }
    const finalUrl = newPage.url();
    if (finalUrl && !/jooble\./i.test(finalUrl) && finalUrl.startsWith("http")) {
      log.info({ finalUrl: finalUrl.slice(0, 120) }, "Resolved /away/ → employer URL");
      return finalUrl;
    }
    log.info({ awayUrl: applyUrl.slice(0, 80), stuckAt: finalUrl?.slice(0, 80) }, "/away/ did not redirect to external");
    return applyUrl;
  } catch (err) {
    log.warn({ err, awayUrl: applyUrl.slice(0, 80) }, "/away/ resolve failed");
    return applyUrl;
  } finally {
    await newPage.close().catch(() => {});
  }
}

async function extractJoobleDescFromLoadedPage(
  page: Page,
  html: string,
  descUrl: string,
): Promise<ScrapeJoobleDescOutcome> {
  const data: {
    expired: boolean;
    cfBlocked?: boolean;
    applyUrl: string;
    title: string;
    company: string;
    location: string;
    salary: string;
    description: string;
  } = await page.evaluate(DESC_EXTRACT_SCRIPT);

  if (data.cfBlocked) {
    log.warn({ url: descUrl.slice(0, 80) }, "CF pattern in /desc/ body");
    return { ok: false, expired: false, reason: "cf_body" };
  }

  if (data.expired) {
    log.info({ url: descUrl.slice(0, 80) }, "Jooble job no longer available (desc page)");
    return { ok: false, expired: true, reason: "jooble_expired" };
  }

  if (html.length < 800) {
    log.warn({ url: descUrl.slice(0, 80), bytes: html.length }, "Unexpectedly small desc page");
    return { ok: false, expired: false, reason: "small_html" };
  }

  const resolvedApply = await resolveAwayUrl(page, data.applyUrl);

  log.info(
    {
      title: data.title?.slice(0, 50),
      company: data.company,
      hasApply: !!resolvedApply,
      bytes: html.length,
    },
    "Scraped Jooble desc page",
  );

  const detail: JoobleJobDetail = {
    title: data.title || "",
    company: data.company || "",
    location: data.location || "",
    salary: data.salary || "",
    description: data.description || "",
    applyUrl: resolvedApply || "",
    sourceUrl: descUrl,
  };

  return { ok: true, detail };
}

export async function extractApplyOnlyFromLoadedPage(page: Page, descUrl: string): Promise<ScrapeJoobleDescOutcome> {
  const data = (await page.evaluate(JOOBLE_APPLY_ONLY_SCRIPT)) as {
    cfBlocked: boolean;
    expired: boolean;
    applyUrl: string;
    pageTitle: string;
  };

  if (data.cfBlocked) {
    log.warn({ url: descUrl.slice(0, 80) }, "CF pattern in /desc/ head (apply-only)");
    return { ok: false, expired: false, reason: "cf_body" };
  }

  if (data.expired) {
    log.info({ url: descUrl.slice(0, 80) }, "Jooble job no longer available (apply-only)");
    return { ok: false, expired: true, reason: "jooble_expired" };
  }

  const resolvedApply = await resolveAwayUrl(page, data.applyUrl);

  log.info(
    {
      title: data.pageTitle?.slice(0, 50),
      hasApply: !!resolvedApply,
      mode: "apply-only-minimal",
    },
    "Jooble desc apply-only",
  );

  const detail: JoobleJobDetail = {
    title: data.pageTitle || "",
    company: "",
    location: "",
    salary: "",
    description: "",
    applyUrl: resolvedApply || "",
    sourceUrl: descUrl,
  };

  return { ok: true, detail };
}

export type ScrapeJoobleDescOnPageOptions = {
  /**
   * Block images/CSS/fonts/media, skip `page.content()` to Node, run apply-link-only evaluate.
   * Saves Webshare/proxy bandwidth; main document + scripts still load (Jooble may need JS).
   */
  minimalBandwidth?: boolean;
  /** If routes were already attached on this page (e.g. batch loop), set true to avoid duplicate handlers. */
  skipAttachRoutes?: boolean;
};

/**
 * One /desc/ navigation in an existing tab (cf-bypass-scraper: reuse session, single tab).
 */
export async function scrapeJoobleDescOnPage(
  page: Page,
  descUrl: string,
  options?: ScrapeJoobleDescOnPageOptions,
): Promise<ScrapeJoobleDescOutcome> {
  if (options?.minimalBandwidth && !options?.skipAttachRoutes) {
    await attachMinimalBandwidthRoutes(page);
  }

  const { html, blocked } = await navigateExistingPage(page, descUrl, {
    ...DESC_NAV_OPTS,
    omitHtml: options?.minimalBandwidth ?? false,
  });

  if (blocked) {
    log.warn({ url: descUrl.slice(0, 80) }, "CF blocked /desc/ page");
    return { ok: false, expired: false, reason: "cf_blocked" };
  }

  if (options?.minimalBandwidth) {
    return extractApplyOnlyFromLoadedPage(page, descUrl);
  }

  return extractJoobleDescFromLoadedPage(page, html, descUrl);
}

/**
 * Scrape a single /desc/ page: full JD + employer apply URL, or mark expired / CF.
 * Opens a new tab (use {@link scrapeJoobleDescOnPage} + {@link withCdpTab} for batch).
 */
export async function scrapeJoobleDesc(descUrl: string): Promise<ScrapeJoobleDescOutcome> {
  const { page, html, blocked } = await navigateWithCf(descUrl, DESC_NAV_OPTS);

  try {
    if (blocked) {
      log.warn({ url: descUrl.slice(0, 80) }, "CF blocked /desc/ page");
      return { ok: false, expired: false, reason: "cf_blocked" };
    }

    return extractJoobleDescFromLoadedPage(page, html, descUrl);
  } finally {
    await releasePage(page);
  }
}

const MAX_PAGES = 5;

const PROXY_CHROME_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-extensions",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--safebrowsing-disable-auto-update",
];

/**
 * Launch a proxy-backed Chrome and verify connectivity with a quick test navigation.
 * Returns null if the proxy can't reach jooble.org.
 */
async function launchProxyBrowser(
  proxy: BrowserProxyConfig,
  args: string[],
): Promise<{ browser: Awaited<ReturnType<typeof chromium.launch>>; ctx: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newContext"]>>; page: Page } | null> {
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args,
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
  });

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "en-GB",
      timezoneId: "Europe/London",
      ignoreHTTPSErrors: true,
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await ctx.newPage();
    await attachMinimalBandwidthRoutes(page);

    // Quick connectivity test + CF warmup
    await page.goto("https://jooble.org", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(2000);
    const title = await page.title();
    if (/just a moment/i.test(title)) {
      log.info({ proxy: proxy.server }, "Proxy warmup: CF challenge, waiting 15s...");
      await page.waitForTimeout(15_000);
    }
    log.info({ proxy: proxy.server, user: proxy.username }, "Proxy warmup OK");
    appendLog("success", `Jooble: proxy ${proxy.username} connected`);
    return { browser, ctx, page };
  } catch (err) {
    log.warn({ err, proxy: proxy.server, user: proxy.username }, "Proxy not reachable, skipping");
    await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Resolve apply URLs for a batch of /desc/ cards using a Webshare proxy context.
 * Tries multiple proxy slots and uses the first reachable one.
 * Minimal bandwidth: blocks images/CSS/fonts/media, runs apply-only script, skips HTML to Node.
 */
async function resolveApplyUrlsViaProxy(
  cards: SearchCardData[],
  maxDesc: number,
  delayMs: number,
  proxies: BrowserProxyConfig[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const noSandbox = process.env.NODE_ENV === "production" || process.env.CHROME_NO_SANDBOX === "1";
  const args = noSandbox ? [...PROXY_CHROME_ARGS, "--no-sandbox", "--disable-setuid-sandbox"] : PROXY_CHROME_ARGS;

  // Find a working proxy slot
  let session: Awaited<ReturnType<typeof launchProxyBrowser>> = null;
  for (const proxy of proxies) {
    session = await launchProxyBrowser(proxy, args);
    if (session) break;
  }

  if (!session) {
    log.warn({ tried: proxies.length }, "All proxy slots failed, no apply URLs resolved via proxy");
    appendLog("error", `Jooble: all ${proxies.length} proxy slots unreachable`);
    return resolved;
  }

  const { browser, page } = session;
  try {
    let cfFailStreak = 0;
    let tunnelFailStreak = 0;
    const maxCfFails = 3;
    const maxTunnelFails = 2;

    for (let i = 0; i < Math.min(maxDesc, cards.length); i++) {
      if (cfFailStreak >= maxCfFails) {
        log.warn({ failStreak: cfFailStreak }, "Too many CF blocks on proxy, stopping");
        break;
      }
      if (tunnelFailStreak >= maxTunnelFails) {
        log.warn({ failStreak: tunnelFailStreak }, "Proxy tunnel lost, stopping to save bandwidth");
        break;
      }

      const card = cards[i]!;
      try {
        await page.goto(card.descUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(1500);
        tunnelFailStreak = 0;

        const data = (await page.evaluate(JOOBLE_APPLY_ONLY_SCRIPT)) as {
          cfBlocked: boolean; expired: boolean; applyUrl: string; pageTitle: string;
        };

        if (data.cfBlocked) {
          cfFailStreak++;
          log.warn({ url: card.descUrl.slice(0, 60), streak: cfFailStreak }, "CF block on proxy /desc/");
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        cfFailStreak = 0;

        if (data.expired) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        let applyUrl = data.applyUrl;
        if (applyUrl?.includes("/away/")) {
          applyUrl = await resolveAwayUrl(page, applyUrl);
        }

        if (isExternalEmployerApplyUrl(applyUrl)) {
          resolved.set(card.descUrl, applyUrl);
          log.info(
            { idx: i + 1, total: Math.min(maxDesc, cards.length), applyUrl: applyUrl.slice(0, 100) },
            "Proxy: resolved employer URL",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("ERR_TUNNEL_CONNECTION_FAILED") || msg.includes("ERR_PROXY_CONNECTION_FAILED")) {
          tunnelFailStreak++;
          log.warn({ url: card.descUrl.slice(0, 60), streak: tunnelFailStreak }, "Proxy tunnel error on /desc/");
        } else {
          log.warn({ err, url: card.descUrl.slice(0, 60) }, "Proxy /desc/ failed");
        }
      }

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log.info({ resolved: resolved.size, total: Math.min(maxDesc, cards.length) }, "Proxy apply URL batch complete");
  if (resolved.size > 0) {
    appendLog("success", `Jooble: ${resolved.size}/${Math.min(maxDesc, cards.length)} external apply URLs resolved`);
  } else {
    appendLog("warn", `Jooble: no external apply URLs resolved (${Math.min(maxDesc, cards.length)} tried)`);
  }
  return resolved;
}

export async function scrapeJoobleForKeyword(
  keyword: string,
  location: string,
  maxResults = 100,
): Promise<JoobleJobDetail[]> {
  const allCards: SearchCardData[] = [];
  const seenUrls = new Set<string>();

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    if (allCards.length >= maxResults) break;

    const searchUrl = `https://jooble.org/SearchResult?rgns=${encodeURIComponent(location)}&ukw=${encodeURIComponent(keyword)}&p=${pageNum}`;

    log.info({ keyword, page: pageNum, maxPages: MAX_PAGES, cardsCollected: allCards.length }, "Loading search page");
    appendLog("info", `Jooble「${keyword}」: search page ${pageNum}…`);

    const { page, blocked, html } = await navigateWithCf(searchUrl, { timeoutMs: 30_000 });

    try {
      if (blocked) {
        log.warn({ keyword, page: pageNum }, "CF blocked search page");
        break;
      }

      await page.waitForTimeout(3000);
      const cards = (await page.evaluate(SEARCH_EXTRACT_SCRIPT)) as SearchCardData[];

      const newCards = cards.filter((c) => {
        const id = c.descUrl.match(/desc\/([^?]+)/)?.[1] ?? c.descUrl;
        if (seenUrls.has(id)) return false;
        seenUrls.add(id);
        return true;
      });

      log.info(
        { keyword, page: pageNum, rawCards: cards.length, newCards: newCards.length, htmlBytes: html.length },
        "Extracted search page cards",
      );

      if (newCards.length === 0) {
        log.info({ keyword, page: pageNum }, "No new cards found, stopping pagination");
        break;
      }

      allCards.push(...newCards);

      if (pageNum < MAX_PAGES && allCards.length < maxResults) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      await releasePage(page);
    }
  }

  if (allCards.length === 0) return [];

  const cardsToProcess = allCards.slice(0, maxResults);
  const maxDesc = Math.min(cardsToProcess.length, getMaxDescFetchesPerKeyword());
  const delayMs = getDescFetchDelayMs();

  appendLog("info", `Jooble「${keyword}」: ${allCards.length} cards, resolving apply URLs…`);

  let proxies: BrowserProxyConfig[] = [];
  const hasWebshareKey = !!getConfig().webshareApiKey;
  if (hasWebshareKey) {
    try {
      proxies = await listWebshareBrowserProxies(5);
      appendLog("info", `Jooble: ${proxies.length} proxy slots available`);
    } catch (err) {
      log.warn({ err }, "Webshare proxies unavailable, falling back to local CDP");
      appendLog("warn", "Jooble: proxy unavailable, using local CDP");
    }
  }

  const useProxy = proxies.length > 0;
  // Force minimal bandwidth when proxy is active (user pays per MB)
  const descMinimal = useProxy ||
    process.env.JOOBLE_DESC_MINIMAL_BANDWIDTH === "1" ||
    process.env.JOOBLE_DESC_MINIMAL_BANDWIDTH === "true";

  log.info(
    {
      keyword,
      totalCards: cardsToProcess.length,
      willFetchDesc: maxDesc,
      delayMs,
      mode: useProxy ? "proxy-apply-only" : "single-tab-desc",
      descMinimalBandwidth: descMinimal,
      proxySlots: proxies.length || 0,
    },
    useProxy
      ? "Resolving employer apply URLs via Webshare proxy (minimal bandwidth, apply-only)"
      : "Resolving employer apply URLs from Jooble /desc/ pages (one session, one tab — cf-bypass-scraper)",
  );

  const jobs: JoobleJobDetail[] = [];
  let expiredSkipped = 0;
  let descFailedFallback = 0;

  if (useProxy) {
    // ── Proxy path: launch separate Chrome with Webshare, only fetch apply URLs ──
    const resolvedMap = await resolveApplyUrlsViaProxy(cardsToProcess, maxDesc, delayMs, proxies);

    for (let i = 0; i < cardsToProcess.length; i++) {
      const card = cardsToProcess[i]!;
      const applyUrl = resolvedMap.get(card.descUrl) ?? "";
      jobs.push({
        title: card.title,
        company: card.company,
        location: card.location,
        salary: card.salary,
        description: card.snippet,
        applyUrl,
        sourceUrl: card.descUrl,
      });
    }
  } else {
    // ── Local CDP path (no proxy) ──
    await withCdpTab(async (page) => {
      if (descMinimal) {
        await attachMinimalBandwidthRoutes(page);
      }
      for (let i = 0; i < maxDesc; i++) {
        const card = cardsToProcess[i]!;
        const outcome = await scrapeJoobleDescOnPage(page, card.descUrl, {
          minimalBandwidth: descMinimal,
          skipAttachRoutes: descMinimal,
        });

        if (!outcome.ok) {
          if (outcome.expired) {
            expiredSkipped++;
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          descFailedFallback++;
          jobs.push({
            title: card.title,
            company: card.company,
            location: card.location,
            salary: card.salary,
            description: card.snippet,
            applyUrl: "",
            sourceUrl: card.descUrl,
          });
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        const d = outcome.detail;
        const useDesc =
          d.description && d.description.length > 100 ? d.description : card.snippet;
        jobs.push({
          title: d.title || card.title,
          company: d.company || card.company,
          location: d.location || card.location,
          salary: d.salary || card.salary,
          description: useDesc,
          applyUrl: isExternalEmployerApplyUrl(d.applyUrl) ? d.applyUrl : "",
          sourceUrl: d.sourceUrl,
        });

        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    });

    if (cardsToProcess.length > maxDesc) {
      const rest = cardsToProcess.slice(maxDesc);
      for (const card of rest) {
        jobs.push({
          title: card.title,
          company: card.company,
          location: card.location,
          salary: card.salary,
          description: card.snippet,
          applyUrl: "",
          sourceUrl: card.descUrl,
        });
      }
      log.warn(
        { keyword, truncated: rest.length, cap: maxDesc },
        "JOOBLE_MAX_DESC_FETCHES cap: remaining cards have no employer apply URL resolved",
      );
    }
  }

  log.info(
    {
      keyword,
      total: jobs.length,
      expiredSkipped,
      descFailedFallback,
      withExternalApply: jobs.filter((j) => isExternalEmployerApplyUrl(j.applyUrl)).length,
      mode: useProxy ? "proxy" : "cdp",
    },
    "Jooble keyword scrape complete",
  );

  return jobs;
}
