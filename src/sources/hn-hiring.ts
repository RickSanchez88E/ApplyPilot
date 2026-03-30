/**
 * HN Who is Hiring — Free via HN Firebase API.
 * Monthly thread, quality: YC companies direct posts.
 *
 * AUDIT FIX (2026-03-26): Added `time` field from HN comment as `postedDate`
 * so orchestrator post-filter can actually work.
 *
 * AUDIT FIX (2026-03-30): Extract company career URLs from comment HTML
 * as applyUrl. Previously only the HN item link was used, causing the
 * apply-resolver to navigate to ycombinator.com/apply/ instead of the
 * actual employer's ATS page. This blocked ~141 jobs at requires_login.
 */
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-hn" });
const HN_API = "https://hacker-news.firebaseio.com/v0";

/**
 * Known ATS / career-page patterns — URLs matching these get highest priority.
 */
const ATS_URL_PATTERNS = [
  /greenhouse\.io/i, /boards\.greenhouse/i,
  /lever\.co/i, /jobs\.lever/i,
  /ashbyhq\.com/i, /bamboohr\.com/i,
  /smartrecruiters\.com/i, /workday\.com/i, /myworkdayjobs/i,
  /icims\.com/i, /jobvite\.com/i, /recruitee\.com/i,
  /breezy\.hr/i, /applytojob\.com/i,
  /workable\.com/i,
];

const CAREER_URL_PATTERNS = [
  /\/careers?\b/i, /\/jobs?\b/i, /\/openings?\b/i,
  /\/positions?\b/i, /\/hiring\b/i, /\/apply\b/i,
  /\/vacancies/i, /\/join\b/i, /\/work-with-us/i,
];

const SKIP_DOMAINS = new Set([
  "news.ycombinator.com",
  "www.ycombinator.com",
  "ycombinator.com",
  "github.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "www.linkedin.com",
  "en.wikipedia.org",
]);

/**
 * Extract the best apply/career URL from an HN comment's HTML.
 * Priority: ATS domain > /careers or /jobs path > company homepage.
 */
function extractBestApplyUrl(html: string): string | undefined {
  // Extract all href values from <a> tags
  const hrefRegex = /href="([^"]+)"/gi;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1]!
      .replace(/&amp;/g, "&")
      .replace(/&#x2F;/g, "/")
      .replace(/&#x3D;/g, "=")
      .trim();
    if (url.startsWith("http")) {
      try {
        const parsed = new URL(url);
        if (!SKIP_DOMAINS.has(parsed.hostname)) {
          urls.push(url);
        }
      } catch {
        // invalid URL, skip
      }
    }
  }

  if (urls.length === 0) return undefined;

  // Score each URL
  const scored = urls.map((url) => {
    let score = 10; // base score for any external URL
    if (ATS_URL_PATTERNS.some((p) => p.test(url))) score += 100;
    if (CAREER_URL_PATTERNS.some((p) => p.test(url))) score += 50;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url;
}

export const hnHiringAdapter: SourceAdapter = {
  name: "hn_hiring",
  displayName: "HN Who is Hiring",
  supportsNativeTimeFilter: false,  // HN Firebase API returns full comment tree
  minTimeGranularityHours: null,

  async fetchJobs(keywords: string[], location: string, _options?: FetchOptions): Promise<NewJob[]> {
    try {
      // Step 1: Find the LATEST "Who is hiring?" thread.
      const searchRes = await fetch(
        "https://hn.algolia.com/api/v1/search_by_date?query=%22Ask+HN%3A+Who+is+hiring%22&tags=story,ask_hn&hitsPerPage=1",
        { signal: AbortSignal.timeout(10000) },
      );

      if (!searchRes.ok) {
        log.warn({ status: searchRes.status }, "HN Algolia search failed");
        return [];
      }

      const searchData = (await searchRes.json()) as { hits: Array<{ objectID: string; title: string }> };
      const latestThread = searchData.hits[0];
      if (!latestThread) {
        log.warn("No HN hiring thread found");
        return [];
      }

      log.info({ threadId: latestThread.objectID, title: latestThread.title }, "Found HN hiring thread");

      // Step 2: Fetch child comment IDs (job posts)
      const threadRes = await fetch(
        `${HN_API}/item/${latestThread.objectID}.json`,
        { signal: AbortSignal.timeout(10000) },
      );
      const threadData = (await threadRes.json()) as { kids?: number[] };
      const commentIds = threadData.kids?.slice(0, 200) ?? []; // Cap at 200

      // Step 3: Fetch comments in parallel (batches of 20)
      const allJobs: NewJob[] = [];
      const keywordsLower = keywords.map((k) => k.toLowerCase());
      let urlExtracted = 0;

      for (let i = 0; i < commentIds.length; i += 20) {
        const batch = commentIds.slice(i, i + 20);
        const comments = await Promise.all(
          batch.map(async (id) => {
            try {
              const r = await fetch(`${HN_API}/item/${id}.json`, { signal: AbortSignal.timeout(5000) });
              return (await r.json()) as { text?: string; by?: string; id: number; time?: number };
            } catch {
              return null;
            }
          }),
        );

        for (const c of comments) {
          if (!c?.text) continue;

          const text = c.text;
          const textLower = text.toLowerCase();

          // Filter: must mention location or keywords
          const locationMatch = textLower.includes("london") || textLower.includes("uk") || textLower.includes("remote");
          const keywordMatch = keywordsLower.some((kw) => textLower.includes(kw));

          if (!locationMatch && !keywordMatch) continue;

          // Parse: first line is usually "CompanyName | Role | Location | ..."
          const plainText = text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
          const firstLine = plainText.split("\n")[0] ?? "";
          const parts = firstLine.split("|").map((s) => s.trim());

          const company = parts[0] ?? c.by ?? "Unknown";
          const title = parts[1] ?? "Software Engineer";
          const loc = parts.find((p) => p.toLowerCase().includes("london") || p.toLowerCase().includes("remote")) ?? location;

          // Extract company career URL from comment HTML
          const extractedUrl = extractBestApplyUrl(text);
          if (extractedUrl) urlExtracted++;

          allJobs.push({
            companyName: company.slice(0, 100),
            jobTitle: title.slice(0, 200),
            location: loc.slice(0, 200),
            jdRaw: plainText.slice(0, 5000),
            applyType: "external",
            applyUrl: extractedUrl,
            source: "hn_hiring",
            sourceUrl: `https://news.ycombinator.com/item?id=${c.id}`,
            // FIX: Use HN comment timestamp as postedDate so post-filter works
            postedDate: c.time ? new Date(c.time * 1000) : undefined,
          });
        }
      }

      log.info({
        total: allJobs.length,
        threadComments: commentIds.length,
        urlExtracted,
      }, "HN hiring parsing complete");
      return allJobs;
    } catch (err) {
      log.error({ err }, "HN hiring fetch failed");
      return [];
    }
  },
};
