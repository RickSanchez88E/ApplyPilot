/**
 * Core LinkedIn scraper — authenticated HTTP requests with cookie auth.
 * DOM parsing first, Playwright only as dynamic fallback.
 */

import { RateLimitError, ScrapingError, SessionExpiredError } from "../shared/errors.js";
import { createChildLogger } from "../lib/logger.js";
import type { NewJob } from "../shared/types.js";
import { hashUrl, sleepWithJitter, withRetry } from "../lib/utils.js";
import { getExistingHashes } from "./dedup.js";
import { mergeIntoNewJob, parseJobDetailHtml, parseSearchResultsHtml } from "./job-parser.js";
import { enhanceJobWithAtsData } from "./ats-scraper.js";
import { updateProgress, incrementStat } from "../lib/progress.js";
import {
  assertSessionValid,
  buildLinkedInHeaders,
  isSessionExpiredResponse,
  type SessionState,
} from "./session-manager.js";

const log = createChildLogger({ module: "scraper" });

const USER_AGENTS: ReadonlyArray<string> = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
];

const LINKEDIN_JOBS_SEARCH_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const REQUEST_DELAY_BASE_MS = 3_000;
const MAX_PAGES = 3;
const RESULTS_PER_PAGE = 25;

function pickUserAgent(): string {
  const idx = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[idx] ?? USER_AGENTS[0] ?? "Mozilla/5.0";
}

function buildSearchUrl(
  keywords: string,
  location: string,
  timeFilter: string,
  start: number,
): string {
  const params = new URLSearchParams({
    keywords,
    location,
    f_TPR: timeFilter,
    start: String(start),
    sortBy: "DD",
  });

  return `${LINKEDIN_JOBS_SEARCH_URL}?${params.toString()}`;
}

async function fetchWithAuth(url: string, session: SessionState): Promise<string> {
  assertSessionValid(session);

  const userAgent = pickUserAgent();
  const headers = buildLinkedInHeaders(session, userAgent);

  log.debug({ url: url.slice(0, 100) }, "Fetching URL");

  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const retryMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000;
    log.warn({ retryMs }, "Rate limited by LinkedIn");
    throw new RateLimitError(retryMs);
  }

  if (isSessionExpiredResponse(response.status, response.headers)) {
    log.error({ status: response.status }, "Session expired during fetch");
    throw new SessionExpiredError();
  }

  if (!response.ok) {
    throw new ScrapingError(
      `HTTP ${response.status} fetching ${url.slice(0, 80)}`,
      response.status,
    );
  }

  return response.text();
}

async function fetchWithRetry(url: string, session: SessionState): Promise<string> {
  return withRetry(() => fetchWithAuth(url, session), {
    maxRetries: 3,
    baseDelayMs: 5_000,
    label: `fetch ${url.slice(0, 60)}`,
  });
}

export interface ScrapeResult {
  readonly jobs: ReadonlyArray<NewJob>;
  readonly pagesScraped: number;
  readonly totalParsed: number;
  readonly skippedExisting: number;
}

export async function scrapeJobs(
  session: SessionState,
  keywords: string,
  location: string,
  timeFilter: string,
): Promise<ScrapeResult> {
  const jobs: NewJob[] = [];
  let pagesScraped = 0;
  let totalParsed = 0;
  let skippedExisting = 0;
  let detailAttempts = 0;
  let detailFailures = 0;
  let parseAnomalies = 0;

  log.info({ keywords, location, timeFilter }, "Starting scrape cycle");

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * RESULTS_PER_PAGE;
    const searchUrl = buildSearchUrl(keywords, location, timeFilter, start);

    updateProgress({
      stage: "scraping_page",
      current: page + 1,
      total: MAX_PAGES,
      percent: Math.round(((page) / MAX_PAGES) * 50),
      message: `Fetching search page ${page + 1}/${MAX_PAGES} for "${keywords}"`,
      keyword: keywords,
    });

    log.info({ page: page + 1, start }, "Fetching search results page");

    let html: string;
    try {
      html = await fetchWithRetry(searchUrl, session);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      log.error({ err, page }, "Failed to fetch search page, stopping pagination");
      break;
    }

    pagesScraped += 1;
    incrementStat("pagesScraped");

    const stubs = parseSearchResultsHtml(html);
    totalParsed += stubs.length;

    if (stubs.length === 0) {
      const level = page === 0 ? "warn" : "info";
      log[level]({ page: page + 1, keywords }, "No results on page, stopping pagination");
      break;
    }

    const stubUrls = stubs.map((s) => s.linkedinUrl);
    const existingHashes = await getExistingHashes(stubUrls);
    const newStubs = stubs.filter((s) => !existingHashes.has(hashUrl(s.linkedinUrl)));
    skippedExisting += stubs.length - newStubs.length;

    log.info(
      { total: stubs.length, new: newStubs.length, existing: stubs.length - newStubs.length },
      "Filtered search results",
    );

    for (let si = 0; si < newStubs.length; si++) {
      const stub = newStubs[si]!;
      try {
        detailAttempts += 1;

        updateProgress({
          stage: "parsing_details",
          current: si + 1,
          total: newStubs.length,
          percent: Math.round(50 + ((si) / Math.max(newStubs.length, 1)) * 30),
          message: `Parsing job detail ${si + 1}/${newStubs.length} (page ${page + 1})`,
        });

        await sleepWithJitter(REQUEST_DELAY_BASE_MS);

        const jobIdMatch = stub.linkedinUrl.match(/\/jobs\/view\/(\d+)/);
        const detailUrl = jobIdMatch?.[1]
          ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobIdMatch[1]}`
          : stub.linkedinUrl;

        const detailHtml = await fetchWithRetry(detailUrl, session);
        const detail = parseJobDetailHtml(detailHtml);
        const missingApplyMetadata = detail.applyType === "external" && !detail.applyUrl;
        const missingDescription = detail.jdRaw === "No description available";

        if (missingApplyMetadata || missingDescription) {
          parseAnomalies += 1;
          log.warn(
            {
              url: stub.linkedinUrl,
              missingApplyMetadata,
              missingDescription,
            },
            "Parsed job detail with degraded metadata",
          );
        }

        let newJob = mergeIntoNewJob(stub, detail);
        
        // Enhance with native ATS data if applicable
        if (newJob.atsPlatform && newJob.atsPlatform !== "generic") {
          updateProgress({
            stage: "ats_enhancement",
            message: `Enhancing with ${newJob.atsPlatform} data...`,
            percent: Math.round(80 + ((si) / Math.max(newStubs.length, 1)) * 10),
          });
        }
        newJob = await enhanceJobWithAtsData(newJob);

        jobs.push(newJob);
        incrementStat("jobsParsed");

        log.debug({ title: newJob.jobTitle, company: newJob.companyName }, "Parsed job detail");
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        detailFailures += 1;
        incrementStat("errors");
        log.warn({ err, url: stub.linkedinUrl }, "Failed to fetch job detail, skipping");
      }
    }

    await sleepWithJitter(REQUEST_DELAY_BASE_MS);
  }

  log.info(
    {
      jobs: jobs.length,
      pagesScraped,
      totalParsed,
      skippedExisting,
      detailAttempts,
      detailFailures,
      parseAnomalies,
    },
    "Scrape cycle complete",
  );

  return { jobs, pagesScraped, totalParsed, skippedExisting };
}

export async function scrapeWithPlaywright(session: SessionState, url: string): Promise<string> {
  log.warn({ url }, "Falling back to Playwright for JS-rendered page");

  const { chromium } = await import("playwright");

  let browser: import("playwright").Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: pickUserAgent(),
    });

    await context.addCookies([
      {
        name: "li_at",
        value: session.liAt,
        domain: ".linkedin.com",
        path: "/",
      },
      {
        name: "JSESSIONID",
        value: session.jsessionId,
        domain: ".linkedin.com",
        path: "/",
      },
    ]);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const html = await page.content();

    await page.close();
    await context.close();

    return html;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
