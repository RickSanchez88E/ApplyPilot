/**
 * Jooble CDP Browser Scraper
 *
 * Uses headless Chrome via CDP pool to scrape /desc/ pages.
 * The Chrome instance runs in background with a separate profile,
 * does NOT interfere with user's daily Chrome.
 *
 * Flow:
 *   1. Navigate to /SearchResult to get /desc/ links
 *   2. Visit each /desc/ page (CF auto-passes for persistent Chrome)
 *   3. Extract job details from DOM
 */
import { navigateWithCf } from "../lib/cdp-pool.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "jooble-browser" });

export interface JoobleJobDetail {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly salary: string;
  readonly description: string;
  readonly applyUrl: string;
  readonly sourceUrl: string;
}

/**
 * Scrape job detail from a single /desc/ URL.
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

    // Extract structured data from the DOM
    const data: any = await page.evaluate(`(() => {
      var h1 = document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : "";
      var company = "";
      var location = "";
      var salary = "";
      var description = "";
      var applyUrl = "";

      // Company - look for common selectors
      var companyEl = document.querySelector("[class*='company']") ||
                      document.querySelector("[data-test*='company']");
      if (companyEl) company = companyEl.textContent.trim();

      // Location
      var locEl = document.querySelector("[class*='location']") ||
                  document.querySelector("[class*='geo']");
      if (locEl) location = locEl.textContent.trim();

      // Salary
      var salEl = document.querySelector("[class*='salary']");
      if (salEl) salary = salEl.textContent.trim();

      // Description - get the main content area
      var descEl = document.querySelector("[class*='description']") ||
                   document.querySelector("[class*='vacancy-desc']") ||
                   document.querySelector("article") ||
                   document.querySelector("[class*='content']");
      if (descEl) description = descEl.textContent.trim();
      if (!description) description = document.body.innerText.slice(0, 5000);

      // Apply link
      var applyEl = document.querySelector("a[class*='apply']") ||
                    document.querySelector("a[href*='apply']");
      if (applyEl) applyUrl = applyEl.href || "";

      // Fallback: get from meta
      var metaDesc = document.querySelector('meta[name="description"]');
      if (!description && metaDesc) description = metaDesc.getAttribute("content") || "";

      var ogUrl = document.querySelector('meta[property="og:url"]');
      if (!applyUrl && ogUrl) applyUrl = ogUrl.getAttribute("content") || "";

      return {
        title: h1 || document.title.replace("Jooble - ", ""),
        company: company,
        location: location,
        salary: salary,
        description: description.slice(0, 5000),
        applyUrl: applyUrl,
      };
    })()`);

    log.info(
      { title: data.title?.slice(0, 50), bytes: html.length },
      "Scraped Jooble job detail",
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
    await page.close().catch(() => {});
  }
}

/**
 * Get /desc/ links from the search results page.
 */
export async function getJoobleSearchLinks(
  keywords: string,
  location: string,
  maxResults = 20,
): Promise<Array<{ href: string; text: string }>> {
  const searchUrl = `https://jooble.org/SearchResult?rgns=${encodeURIComponent(location)}&ukw=${encodeURIComponent(keywords)}`;

  const { page, blocked } = await navigateWithCf(searchUrl, {
    timeoutMs: 30_000,
  });

  try {
    if (blocked) {
      log.warn("CF blocked search page");
      return [];
    }

    // Wait for job cards to render
    await page.waitForTimeout(3000);

    const links: Array<{ href: string; text: string }> = await page.evaluate(`(() => {
      var anchors = Array.from(document.querySelectorAll('a[href*="/desc/"]'));
      return anchors.slice(0, ${maxResults}).map(function(a) {
        return {
          href: a.href,
          text: (a.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 100),
        };
      });
    })()`);

    log.info(
      { keywords, location, found: links.length },
      "Got Jooble search links",
    );

    return links;
  } finally {
    await page.close().catch(() => {});
  }
}
