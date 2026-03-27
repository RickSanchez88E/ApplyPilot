/**
 * Jooble CDP Browser Scraper v3 — search-page-first strategy
 *
 * Key insight: Jooble uses Cloudflare Turnstile on /desc/ pages, which triggers
 * a 15-35 second challenge PER PAGE. Scraping 60 desc pages = 15-30 minutes.
 *
 * NEW STRATEGY (v3):
 *   1. Navigate to search results page (1 CF challenge)
 *   2. Extract ALL job cards DIRECTLY from search page DOM (title, company, location, salary, snippet)
 *   3. Only scrape /desc/ for top N jobs that need full JD (default: 3 per keyword)
 *
 * This reduces page loads from 60+ to ~12 (3 search + 9 desc), cutting time from 15min to ~3min.
 */
import { navigateWithCf, releasePage } from "../lib/cdp-pool.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "jooble-browser" });

/** Max desc pages to scrape per keyword for full JD */
const MAX_DESC_PER_KEYWORD = 3;

export interface JoobleJobDetail {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly salary: string;
  readonly description: string;
  readonly applyUrl: string;
  readonly sourceUrl: string;
}

/** Data extracted directly from search result cards (no desc page needed) */
interface SearchCardData {
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;   // short description from search card
  descUrl: string;    // /desc/ link for full JD
}

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
  // Jooble DOM: UL > LI > DIV > DIV > H2 (title) + snippet text
  // Each LI contains a link to /desc/ + the card content
  var listItems = document.querySelectorAll('li');
  var seen = new Set();

  for (var li of listItems) {
    // Find /desc/ link inside this LI
    var link = li.querySelector('a[href*="/desc/"]');
    if (!link) continue;

    var href = link.href;
    var descId = href.match(/desc\\/([^?]+)/);
    var key = descId ? descId[1] : href;
    if (seen.has(key)) continue;
    seen.add(key);

    // Title from H2 or link text
    var h2 = li.querySelector('h2');
    var title = h2 ? h2.textContent.trim() : link.textContent.trim();

    // Full card text — contains title + snippet
    var fullText = li.innerText || "";

    // Snippet: everything after the title in the card text
    var snippet = "";
    var titlePos = fullText.indexOf(title);
    if (titlePos >= 0) {
      snippet = fullText.slice(titlePos + title.length).trim();
      // Clean up: remove "..." prefix pattern from Jooble
      snippet = snippet.replace(/^\\.{3}\\s*/, "").replace(/\\s+/g, " ").slice(0, 500);
    }

    // Try to extract company from snippet
    // Jooble snippets often start with company context or contain company name
    var company = "";
    var location = "";

    // Check title for location pattern: "Title - Location"
    var titleLocMatch = title.match(/^(.+?)\\s*[-–]\\s*((?:[A-Z][a-z]+(?:,\\s*)?)+(?:United Kingdom|UK|London|England|Scotland|Wales)?)$/);
    if (titleLocMatch) {
      title = titleLocMatch[1].trim();
      location = titleLocMatch[2].trim();
    }

    // Salary detection
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

// Extraction script for /desc/ detail pages
const DESC_EXTRACT_SCRIPT = `(() => {
  // CF Challenge Detection — abort if this is a challenge page
  var pageText = (document.title + " " + document.body.innerText.slice(0, 500)).toLowerCase();
  var cfPatterns = ["just a moment", "checking your browser", "cf-browser-verification",
    "attention required", "enable javascript", "ray id", "security check",
    "verifying you are human", "challenge-platform", "turnstile"];
  for (var p of cfPatterns) {
    if (pageText.includes(p)) return null;
  }

  var h1 = document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : "";
  var company = "";
  var location = "";
  var salary = "";
  var description = "";
  var applyUrl = "";
  var titleLine = "";

  var bodyText = document.body.innerText || "";
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

  var ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) applyUrl = ogUrl.getAttribute("content") || "";
  if (!applyUrl) {
    var applyEl = document.querySelector("a[href*='apply']");
    if (applyEl) applyUrl = applyEl.href || "";
  }

  return {
    title: h1 || titleLine || document.title.replace("Jooble - ", ""),
    company: company,
    location: location,
    salary: salary,
    description: description.slice(0, 5000),
    applyUrl: applyUrl,
  };
})()`;

/**
 * Scrape a single /desc/ page for full JD.
 */
export async function scrapeJoobleDesc(descUrl: string): Promise<JoobleJobDetail | null> {
  const { page, html, blocked } = await navigateWithCf(descUrl, {
    referer: "https://jooble.org/SearchResult",
    timeoutMs: 25_000,
  });

  try {
    if (blocked) {
      log.warn({ url: descUrl.slice(0, 80) }, "CF blocked /desc/ page");
      return null;
    }
    if (html.length < 10_000) {
      log.warn({ url: descUrl.slice(0, 80), bytes: html.length }, "Unexpectedly small page");
      return null;
    }

    const data: any = await page.evaluate(DESC_EXTRACT_SCRIPT);
    log.info(
      { title: data.title?.slice(0, 50), company: data.company, bytes: html.length },
      "Scraped Jooble desc page",
    );

    return {
      title: data.title || "",
      company: data.company || "",
      location: data.location || "",
      salary: data.salary || "",
      description: data.description || "",
      applyUrl: data.applyUrl || "",
      sourceUrl: descUrl,
    };
  } finally {
    await releasePage(page);
  }
}

/**
 * Main entry: multi-page search extraction + selective desc enrichment.
 *
 * Pagination: scrapes up to MAX_PAGES search result pages per keyword.
 * Each page is a single page load (~5s, CF session already active).
 * With 3 keywords × 5 pages × ~20 cards = ~300 jobs in ~3 minutes.
 */

const MAX_PAGES = 5;

export async function scrapeJoobleForKeyword(
  keyword: string,
  location: string,
  maxResults = 100,
): Promise<JoobleJobDetail[]> {
  const allCards: SearchCardData[] = [];
  const seenUrls = new Set<string>();

  // Step 1: Scrape multiple search result pages
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    if (allCards.length >= maxResults) break;

    const searchUrl = `https://jooble.org/SearchResult?rgns=${encodeURIComponent(location)}&ukw=${encodeURIComponent(keyword)}&p=${pageNum}`;

    log.info({ keyword, page: pageNum, maxPages: MAX_PAGES, cardsCollected: allCards.length }, "Loading search page");

    const { page, blocked, html } = await navigateWithCf(searchUrl, { timeoutMs: 30_000 });

    try {
      if (blocked) {
        log.warn({ keyword, page: pageNum }, "CF blocked search page");
        break; // Don't try further pages if CF blocks
      }

      await page.waitForTimeout(3000);
      let cards = await page.evaluate(SEARCH_EXTRACT_SCRIPT) as SearchCardData[];

      // Dedup against already-seen URLs
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

      // Pause between pages to be nice to CF
      if (pageNum < MAX_PAGES && allCards.length < maxResults) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } finally {
      await releasePage(page);
    }
  }

  if (allCards.length === 0) return [];

  const cardsToProcess = allCards.slice(0, maxResults);
  log.info({ keyword, totalCards: cardsToProcess.length }, "All search pages scraped");

  // Step 2: Convert search cards to JoobleJobDetail (using snippet as description)
  const jobs: JoobleJobDetail[] = cardsToProcess.map((card) => ({
    title: card.title,
    company: card.company,
    location: card.location,
    salary: card.salary,
    description: card.snippet,
    applyUrl: card.descUrl,
    sourceUrl: card.descUrl,
  }));

  // Step 3: Enrich top N with full JD from /desc/ pages
  const descTargets = jobs.slice(0, MAX_DESC_PER_KEYWORD);
  log.info(
    { keyword, descTargets: descTargets.length, totalCards: jobs.length },
    "Enriching top jobs with full JD from desc pages",
  );

  for (let i = 0; i < descTargets.length; i++) {
    try {
      const detail = await scrapeJoobleDesc(descTargets[i]!.sourceUrl);
      if (detail && detail.description.length > 100) {
        const enriched: JoobleJobDetail = {
          ...jobs[i]!,
          description: detail.description,
          company: detail.company || jobs[i]!.company,
          location: detail.location || jobs[i]!.location,
          salary: detail.salary || jobs[i]!.salary,
        };
        jobs[i] = enriched;
        log.info({ title: enriched.title.slice(0, 40), jdLen: enriched.description.length }, "Enriched with full JD");
      }
    } catch (err) {
      log.warn({ err, url: descTargets[i]!.sourceUrl.slice(0, 60) }, "Desc enrichment failed (keeping snippet)");
    }
  }

  log.info(
    { keyword, total: jobs.length, enriched: Math.min(descTargets.length, jobs.length), pages: Math.min(MAX_PAGES, Math.ceil(allCards.length / 20)) },
    "Jooble keyword scrape complete",
  );

  return jobs;
}

