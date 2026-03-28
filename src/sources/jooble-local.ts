/**
 * Jooble scraper — LOCAL PERSISTENT BROWSER mode.
 *
 * Uses the host machine's Chrome profile (via local-browser-manager) instead of
 * the old CDP pool / Webshare proxy path. Designed for slow, low-cost operation:
 *   - concurrency = 1 (enforced by BullMQ worker config)
 *   - hard cap on desc pages per run
 *   - randomized delays between navigations
 *   - challenge / timeout / login failure → circuit breaker
 *
 * This file does NOT import the old CF-bypass pool, CDP pool, or proxy modules.
 */

import type { Page } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import { createPage, type PageSession } from "../browser/local-browser-manager.js";
import { recordFailure, type FailureType } from "../browser/circuit-breaker.js";
import type { NewJob } from "../shared/types.js";
import { appendLog, incrementStat, updateProgress } from "../lib/progress.js";
import {
  isExternalEmployerApplyUrl,
  type ScrapeJoobleDescOutcome,
} from "./jooble-browser.js";

const log = createChildLogger({ module: "jooble-local" });

const HARD_CAP = parseInt(process.env.JOOBLE_DESC_HARD_CAP ?? "5", 10);
const DELAY_MIN_MS = parseInt(process.env.JOOBLE_PAGE_DELAY_MIN_MS ?? "15000", 10);
const DELAY_MAX_MS = parseInt(process.env.JOOBLE_PAGE_DELAY_MAX_MS ?? "45000", 10);
const MAX_SEARCH_PAGES = parseInt(process.env.JOOBLE_MAX_SEARCH_PAGES ?? "1", 10);
const JOOBLE_CF_THRESHOLD = 1; // single challenge = immediate stop
const JOOBLE_BREAKER_COOLDOWN_MS = parseInt(process.env.JOOBLE_BREAKER_COOLDOWN_MS ?? "43200000", 10); // 12 hours

function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS;
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CF_PATTERNS = [
  "just a moment", "checking your browser", "cf-browser-verification",
  "attention required", "enable javascript", "ray id",
  "verifying you are human", "challenge-platform", "turnstile",
];

async function isCfBlocked(page: Page): Promise<boolean> {
  try {
    const text: string = await page.evaluate(`
      (document.title + " " + (document.body ? document.body.innerText : "").slice(0, 500)).toLowerCase()
    `);
    return CF_PATTERNS.some(p => text.includes(p));
  } catch {
    return false;
  }
}

const SEARCH_EXTRACT_SCRIPT = `(() => {
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
      snippet = fullText.slice(titlePos + title.length).trim().replace(/^\\.{3}\\s*/, "").replace(/\\s+/g, " ").slice(0, 500);
    }
    var company = "";
    var location = "";
    var salary = "";
    var salMatch = fullText.match(/([$£€][\\d,.]+(?:\\s*[-–]\\s*[$£€][\\d,.]+)?(?:\\s*(?:per|a)\\s+(?:hour|year|annum|month|day|week))?)/i);
    if (salMatch) salary = salMatch[0];
    cards.push({ title: title.slice(0, 200), company, location, salary, snippet: snippet || fullText.slice(0, 500), descUrl: href });
  }
  return cards;
})()`;

const DESC_EXTRACT_SCRIPT = `(() => {
  var head = (document.title + " " + (document.body.innerText || "").slice(0, 500)).toLowerCase();
  var cfPatterns = ["just a moment", "checking your browser", "cf-browser-verification",
    "attention required", "enable javascript", "ray id",
    "verifying you are human", "challenge-platform", "turnstile"];
  for (var p of cfPatterns) {
    if (head.includes(p)) return { expired: false, cfBlocked: true, applyUrl: "", title: "", company: "", location: "", salary: "", description: "" };
  }
  var bodyText = document.body.innerText || "";
  var expired = /the job position is no longer available|this job is no longer available|job is no longer available|position is no longer available|listing has expired|job has been removed|vacancy has closed/i.test(bodyText);
  if (expired) return { expired: true, cfBlocked: false, applyUrl: "", title: "", company: "", location: "", salary: "", description: "" };
  function pickApplyUrl() {
    var best = ""; var bestScore = -1;
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i]; var href = a.getAttribute("href");
      if (!href) continue;
      if (href.indexOf("mailto:") === 0 || href.indexOf("tel:") === 0 || href.indexOf("javascript:") === 0) continue;
      var abs = href;
      if (href.indexOf("//") === 0) abs = "https:" + href;
      else if (href.indexOf("http") !== 0) continue;
      var host = "";
      try { host = new URL(abs).hostname.toLowerCase(); } catch (e) { continue; }
      if (host.indexOf("jooble.") >= 0 && abs.indexOf("/away/") < 0) continue;
      if (host.indexOf("facebook.com") >= 0 || host.indexOf("twitter.com") >= 0) continue;
      if (host.indexOf("fitly.work") >= 0) continue;
      var text = (a.textContent || "").trim().toLowerCase();
      var score = 0;
      if (abs.indexOf("/away/") >= 0) score += 50;
      if (abs.indexOf("utm_source=jooble") >= 0) score += 25;
      if (/apply|bewirb|postuler|solicitar/i.test(text)) score += 20;
      if (/career|jobs|greenhouse|lever|workday|ashby|bamboo|icims|smartrecruiters/i.test(host)) score += 15;
      if (score > bestScore) { bestScore = score; best = abs; }
    }
    return best;
  }
  var h1 = document.querySelector("h1"); var title = h1 ? h1.textContent.trim() : document.title.replace(/ - Jooble$/, "").trim();
  var companyEl = document.querySelector('[class*="company"], [data-test*="company"]');
  var company = companyEl ? companyEl.textContent.trim() : "";
  var locEl = document.querySelector('[class*="location"], [data-test*="location"]');
  var location = locEl ? locEl.textContent.trim() : "";
  var salEl = document.querySelector('[class*="salary"]');
  var salary = salEl ? salEl.textContent.trim() : "";
  var descEl = document.querySelector('[class*="description"], [class*="vacancy-desc"], article, main');
  var description = descEl ? descEl.innerText.trim().slice(0, 5000) : bodyText.slice(0, 3000);
  return { expired: false, cfBlocked: false, applyUrl: pickApplyUrl(), title, company, location, salary, description };
})()`;

interface SearchCard {
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;
  descUrl: string;
}

async function resolveAwayUrl(page: Page, applyUrl: string): Promise<string> {
  if (!applyUrl || !applyUrl.includes("/away/")) return applyUrl;
  let newPage: Page | null = null;
  try {
    newPage = await page.context().newPage();
    await newPage.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    try { await newPage.waitForURL(url => !/jooble\./i.test(url.toString()), { timeout: 8000 }); } catch { /* ok */ }
    const finalUrl = newPage.url();
    if (finalUrl && !/jooble\./i.test(finalUrl) && finalUrl.startsWith("http")) {
      log.info({ finalUrl: finalUrl.slice(0, 120) }, "/away/ → employer URL");
      return finalUrl;
    }
    return applyUrl;
  } catch {
    return applyUrl;
  } finally {
    if (newPage) await newPage.close().catch(() => {});
  }
}

async function scrapeDescPage(page: Page, descUrl: string): Promise<ScrapeJoobleDescOutcome> {
  await page.goto(descUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(2000);

  if (await isCfBlocked(page)) {
    return { ok: false, expired: false, reason: "cf_blocked" };
  }

  const data = await page.evaluate(DESC_EXTRACT_SCRIPT) as {
    expired: boolean; cfBlocked: boolean; applyUrl: string;
    title: string; company: string; location: string; salary: string; description: string;
  };

  if (data.cfBlocked) return { ok: false, expired: false, reason: "cf_body" };
  if (data.expired) return { ok: false, expired: true, reason: "jooble_expired" };

  const resolvedApply = await resolveAwayUrl(page, data.applyUrl);

  return {
    ok: true,
    detail: {
      title: data.title || "",
      company: data.company || "",
      location: data.location || "",
      salary: data.salary || "",
      description: data.description || "",
      applyUrl: resolvedApply || "",
      sourceUrl: descUrl,
    },
  };
}

/**
 * Desc page concurrency for Jooble.
 * Default = 2 for the parallel experiment. Set JOOBLE_DESC_CONCURRENCY=1 to revert to serial.
 */
const JOOBLE_DESC_CONCURRENCY = Math.max(1, parseInt(process.env.JOOBLE_DESC_CONCURRENCY ?? "2", 10));

interface DescResult {
  card: SearchCard;
  job: NewJob | null;
  cfBlocked: boolean;
  error: string | null;
}

/**
 * Scrape a single desc page using its OWN page instance (created + closed here).
 * Returns structured result including CF block status.
 */
async function scrapeOneDesc(
  context: import("playwright").BrowserContext,
  card: SearchCard,
  location: string,
): Promise<DescResult> {
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const outcome = await scrapeDescPage(page, card.descUrl);

    if (outcome.ok) {
      const detail = outcome.detail;
      if (detail.title.length >= 5 && detail.description.length >= 50) {
        const applyUrl = isExternalEmployerApplyUrl(detail.applyUrl) ? detail.applyUrl : undefined;
        return {
          card,
          job: {
            companyName: detail.company || card.company || "Unknown",
            jobTitle: detail.title,
            location: detail.location || card.location || location,
            salaryText: detail.salary || card.salary || undefined,
            jdRaw: detail.description,
            applyUrl,
            applyType: "external",
            source: "jooble",
            sourceUrl: detail.sourceUrl,
          },
          cfBlocked: false,
          error: null,
        };
      }
      log.debug({ title: detail.title?.slice(0, 30) }, "Rejected: quality gate");
      return { card, job: null, cfBlocked: false, error: null };
    }

    if (outcome.reason === "cf_blocked" || outcome.reason === "cf_body") {
      return { card, job: null, cfBlocked: true, error: `cf:${outcome.reason}` };
    }
    return { card, job: null, cfBlocked: false, error: outcome.reason ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCf = msg.includes("Cloudflare") || msg.includes("challenge");
    return { card, job: null, cfBlocked: isCf, error: msg };
  } finally {
    if (page) {
      try { await page.close(); } catch { /* already closed */ }
    }
  }
}

/**
 * Run desc scraping with a bounded concurrency pool + abort-on-challenge.
 *
 * - At most `JOOBLE_DESC_CONCURRENCY` desc pages open simultaneously.
 * - If any task detects CF challenge, the abort flag is set:
 *   - No new tasks are dispatched
 *   - In-flight tasks are allowed to finish and close their pages
 * - randomDelay is applied between task dispatches (not between completions)
 */
async function scrapeDescsConcurrently(
  context: import("playwright").BrowserContext,
  cards: SearchCard[],
  location: string,
): Promise<{ jobs: NewJob[]; cfAborted: boolean; peakConcurrent: number }> {
  const jobs: NewJob[] = [];
  let cfAborted = false;
  let activeTasks = 0;
  let peakConcurrent = 0;

  // Semaphore: resolvers waiting for a free slot
  const waiters: Array<() => void> = [];

  function acquireSlot(): Promise<void> {
    if (activeTasks < JOOBLE_DESC_CONCURRENCY) {
      activeTasks++;
      peakConcurrent = Math.max(peakConcurrent, activeTasks);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        activeTasks++;
        peakConcurrent = Math.max(peakConcurrent, activeTasks);
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    activeTasks--;
    const next = waiters.shift();
    if (next) next();
  }

  // Launch tasks, respecting concurrency + abort
  const inFlight: Promise<void>[] = [];

  for (let i = 0; i < cards.length; i++) {
    if (cfAborted) {
      log.info({ remaining: cards.length - i, reason: "cf_abort" }, "Skipping remaining desc tasks due to CF abort");
      break;
    }

    // Apply delay between dispatches (not the first one)
    if (i > 0) {
      await randomDelay();
    }

    // Re-check abort after delay
    if (cfAborted) {
      log.info({ remaining: cards.length - i, reason: "cf_abort_after_delay" }, "Skipping remaining desc tasks due to CF abort");
      break;
    }

    await acquireSlot();

    const card = cards[i]!;
    const taskPromise = (async () => {
      try {
        log.debug({ descUrl: card.descUrl.slice(0, 80), slot: activeTasks }, "Desc task starting");
        const result = await scrapeOneDesc(context, card, location);

        if (result.cfBlocked) {
          cfAborted = true;
          log.warn({ descUrl: card.descUrl.slice(0, 60) }, "CF challenge on desc page — setting abort flag");
        }
        if (result.job) {
          jobs.push(result.job);
        }
        if (result.error && !result.cfBlocked) {
          log.warn({ descUrl: card.descUrl.slice(0, 60), err: result.error }, "Desc scrape failed, skipping");
        }
      } finally {
        releaseSlot();
      }
    })();

    inFlight.push(taskPromise);
  }

  // Wait for all in-flight tasks to complete
  await Promise.allSettled(inFlight);

  return { jobs, cfAborted, peakConcurrent };
}

export async function scrapeJoobleLocal(
  keywords: string[],
  location: string,
): Promise<NewJob[]> {
  const allJobs: NewJob[] = [];
  let consecutiveCfBlocks = 0;

  log.info({ descConcurrency: JOOBLE_DESC_CONCURRENCY, hardCap: HARD_CAP, maxSearchPages: MAX_SEARCH_PAGES },
    "Jooble config: desc concurrency experiment");
  appendLog("info", `Jooble config: hardCap=${HARD_CAP}, searchPages=${MAX_SEARCH_PAGES}, descConcurrency=${JOOBLE_DESC_CONCURRENCY}`, {
    source: "jooble",
    stage: "initializing",
    percent: 4,
  });

  for (const keyword of keywords) {
    let session: PageSession | null = null;
    try {
      session = await createPage("jooble");
      const page = session.page;

      log.info({ keyword, location, mode: "local-persistent-browser", descConcurrency: JOOBLE_DESC_CONCURRENCY }, "Jooble local discover starting");
      updateProgress({
        source: "jooble",
        stage: "scraping_page",
        current: 0,
        total: MAX_SEARCH_PAGES,
        percent: 10,
        keyword,
        message: `[${keyword}] starting search phase`,
      });
      appendLog("info", `[${keyword}] search phase started`);

      const allCards: SearchCard[] = [];
      const seenUrls = new Set<string>();

      // === Search phase: serial, single page ===
      for (let pageNum = 1; pageNum <= MAX_SEARCH_PAGES; pageNum++) {
        if (allCards.length >= HARD_CAP) break;
        const searchUrl = `https://jooble.org/SearchResult?rgns=${encodeURIComponent(location)}&ukw=${encodeURIComponent(keyword)}&p=${pageNum}`;

        log.info({ keyword, page: pageNum, cardsCollected: allCards.length }, "Loading search page (local browser)");
        updateProgress({
          source: "jooble",
          stage: "scraping_page",
          current: pageNum,
          total: MAX_SEARCH_PAGES,
          percent: Math.min(36, 10 + pageNum * 12),
          message: `[${keyword}] loading search page ${pageNum}/${MAX_SEARCH_PAGES}`,
        });
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        if (await isCfBlocked(page)) {
          log.warn({ keyword, page: pageNum }, "CF blocked search page — aborting entire run");
          appendLog("warn", `[${keyword}] Cloudflare detected on search page ${pageNum}`);
          consecutiveCfBlocks++;
          if (consecutiveCfBlocks >= JOOBLE_CF_THRESHOLD) {
            throw new Error(`Cloudflare: ${consecutiveCfBlocks} CF block(s) on search pages — threshold=${JOOBLE_CF_THRESHOLD}`);
          }
          break;
        }
        consecutiveCfBlocks = 0;

        const cards = await page.evaluate(SEARCH_EXTRACT_SCRIPT) as SearchCard[];
        for (const c of cards) {
          const id = c.descUrl.match(/desc\/([^?]+)/)?.[1] ?? c.descUrl;
          if (seenUrls.has(id)) continue;
          seenUrls.add(id);
          allCards.push(c);
        }

        log.info({ keyword, page: pageNum, newCards: cards.length, total: allCards.length }, "Search page extracted");
        incrementStat("pagesScraped");
        appendLog("info", `[${keyword}] search page ${pageNum}: +${cards.length} cards, total=${allCards.length}`);
        if (cards.length === 0) break;
        await randomDelay();
      }

      // === Desc phase: concurrent pool ===
      const toScrape = allCards.slice(0, HARD_CAP);
      log.info({ keyword, toScrape: toScrape.length, hardCap: HARD_CAP, descConcurrency: JOOBLE_DESC_CONCURRENCY },
        "Scraping desc pages (concurrent pool mode)");
      updateProgress({
        source: "jooble",
        stage: "parsing_details",
        current: 0,
        total: toScrape.length,
        percent: 45,
        message: `[${keyword}] scraping ${toScrape.length} desc pages`,
      });
      appendLog("info", `[${keyword}] desc phase started (${toScrape.length} pages)`);

      // Keep the search session alive to prevent browser idle-close.
      // Get context from the search page — desc tasks create their own pages from this context.
      const context = page.context();

      const descResult = await scrapeDescsConcurrently(context, toScrape, location);
      allJobs.push(...descResult.jobs);
      incrementStat("jobsParsed", descResult.jobs.length);
      updateProgress({
        source: "jooble",
        stage: "parsing_details",
        current: toScrape.length,
        total: toScrape.length,
        percent: 82,
        message: `[${keyword}] desc phase done, accepted=${descResult.jobs.length}`,
      });
      appendLog("success", `[${keyword}] desc done: accepted=${descResult.jobs.length}, peak=${descResult.peakConcurrent}`);

      if (descResult.cfAborted) {
        consecutiveCfBlocks++;
        log.warn({ keyword, jobsBeforeAbort: descResult.jobs.length, peakConcurrent: descResult.peakConcurrent },
          "Desc phase aborted due to CF challenge");
        appendLog("warn", `[${keyword}] desc aborted by Cloudflare challenge`);
        if (consecutiveCfBlocks >= JOOBLE_CF_THRESHOLD) {
          throw new Error(`Cloudflare: CF challenge during desc phase — aborting run`);
        }
      } else {
        consecutiveCfBlocks = 0;
      }

      log.info({ keyword, accepted: allJobs.length, peakConcurrent: descResult.peakConcurrent }, "Jooble local keyword complete");
      appendLog("success", `[${keyword}] keyword complete, cumulative accepted=${allJobs.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCf = msg.includes("Cloudflare") || msg.includes("challenge");
      if (isCf) {
        appendLog("warn", `[${keyword}] Cloudflare stop: ${msg}`);
        const failureType: FailureType = "cf_block";
        await recordFailure("jooble", failureType, { maxFailures: 1, cooldownMs: JOOBLE_BREAKER_COOLDOWN_MS });
        throw err;
      }
      log.error({ keyword, err: msg }, "Jooble local keyword failed");
      appendLog("error", `[${keyword}] keyword failed: ${msg}`);
    } finally {
      if (session) await session.close();
    }
  }

  log.info({ totalJobs: allJobs.length, keywords: keywords.length, mode: "local-persistent-browser", descConcurrency: JOOBLE_DESC_CONCURRENCY }, "Jooble local discover complete");
  appendLog("success", `Jooble crawl complete: ${allJobs.length} candidates`);
  return allJobs;
}


