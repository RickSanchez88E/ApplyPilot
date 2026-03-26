/**
 * HN Who is Hiring — Free via HN Firebase API.
 * Monthly thread, quality: YC companies direct posts.
 *
 * AUDIT FIX (2026-03-26): Added `time` field from HN comment as `postedDate`
 * so orchestrator post-filter can actually work.
 */
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-hn" });
const HN_API = "https://hacker-news.firebaseio.com/v0";

export const hnHiringAdapter: SourceAdapter = {
  name: "hn_hiring",
  displayName: "HN Who is Hiring",
  supportsNativeTimeFilter: false,  // HN Firebase API returns full comment tree
  minTimeGranularityHours: null,

  async fetchJobs(keywords: string[], location: string, _options?: FetchOptions): Promise<NewJob[]> {
    try {
      // Step 1: Find the LATEST "Who is hiring?" thread.
      // CRITICAL FIX: Use search_by_date to sort by recency instead of relevance.
      // The default /search endpoint returns relevance-ranked results (e.g., a 2020 post).
      // Also filter title to "Ask HN: Who is hiring?" to avoid generic matches.
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

          allJobs.push({
            companyName: company.slice(0, 100),
            jobTitle: title.slice(0, 200),
            location: loc.slice(0, 200),
            jdRaw: plainText.slice(0, 5000),
            applyType: "external",
            source: "hn_hiring",
            sourceUrl: `https://news.ycombinator.com/item?id=${c.id}`,
            // FIX: Use HN comment timestamp as postedDate so post-filter works
            postedDate: c.time ? new Date(c.time * 1000) : undefined,
          });
        }
      }

      log.info({ total: allJobs.length, threadComments: commentIds.length }, "HN hiring parsing complete");
      return allJobs;
    } catch (err) {
      log.error({ err }, "HN hiring fetch failed");
      return [];
    }
  },
};
