/**
 * Jooble source adapter — CDP-based.
 *
 * Two-step flow:
 *   1. Get /desc/ links from search page via headless Chrome
 *   2. Scrape each /desc/ page for full job details
 *
 * No longer depends on Jooble API key. All data comes from the browser.
 * Chrome runs headless in background with separate profile, does NOT
 * interfere with user's daily Chrome.
 */
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";
import { getJoobleSearchLinks, scrapeJoobleDesc } from "./jooble-browser.js";

const log = createChildLogger({ module: "source-jooble" });

export const joobleAdapter: SourceAdapter = {
  name: "jooble",
  displayName: "Jooble",
  supportsNativeTimeFilter: false,
  minTimeGranularityHours: null,

  async fetchJobs(keywords: string[], location: string, _options?: FetchOptions): Promise<NewJob[]> {
    const allJobs: NewJob[] = [];

    for (const kw of keywords) {
      try {
        log.info({ keyword: kw, location }, "Fetching Jooble jobs via CDP browser");

        // Step 1: Get /desc/ links from search page
        const links = await getJoobleSearchLinks(kw, location, 15);
        if (links.length === 0) {
          log.warn({ keyword: kw }, "No Jooble search results found");
          continue;
        }

        log.info({ keyword: kw, count: links.length }, "Found Jooble search results");

        // Step 2: Scrape each /desc/ page (with rate limiting)
        let scraped = 0;
        for (const link of links) {
          try {
            const detail = await scrapeJoobleDesc(link.href);
            if (!detail) {
              continue;
            }

            allJobs.push({
              companyName: detail.company || "Unknown",
              jobTitle: detail.title || kw,
              location: detail.location || location,
              salaryText: detail.salary || undefined,
              jdRaw: detail.description,
              applyUrl: detail.applyUrl || link.href,
              applyType: "external",
              source: "jooble",
              sourceUrl: link.href,
            });

            scraped++;

            // Rate limit: 2s between page loads to be nice
            await new Promise(r => setTimeout(r, 2000));
          } catch (err) {
            log.warn({ err, url: link.href.slice(0, 80) }, "Failed to scrape Jooble desc page");
          }
        }

        log.info({ keyword: kw, scraped, total: links.length }, "Jooble keyword batch complete");
      } catch (err) {
        log.error({ err, keyword: kw }, "Jooble fetch failed");
      }
    }

    return allJobs;
  },
};
