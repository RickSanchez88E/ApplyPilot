/**
 * DevITJobs.uk — Free public API: /api/jobsLight returns full job list as JSON.
 * UK IT-specific: shows tech stack + salary transparency.
 *
 * NOTE (2026-03): The old /api/jobSearch endpoint now returns HTML (React SPA).
 *       The correct data endpoint is /api/jobsLight which returns ALL jobs as a
 *       JSON array, with no pagination or keyword params — we filter client-side.
 */
import type { SourceAdapter } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-devitjobs" });

const JOBS_URL = "https://devitjobs.uk/api/jobsLight";

// Local cache to avoid hammering the API (return full list, filter client-side)
let cachedJobs: any[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getAllJobs(): Promise<any[]> {
  const now = Date.now();
  if (cachedJobs && (now - cacheTime) < CACHE_TTL) {
    log.info({ cached: true, count: cachedJobs.length }, "DevITJobs using cached data");
    return cachedJobs;
  }

  log.info("Fetching full DevITJobs listing from /api/jobsLight");
  const res = await fetch(JOBS_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(30000), // generous timeout — response is large
  });

  if (!res.ok) {
    throw new Error(`DevITJobs API returned ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("DevITJobs: unexpected response format");
  }

  cachedJobs = data;
  cacheTime = now;
  log.info({ count: data.length }, "DevITJobs fetched full listing");
  return data;
}

export const devitjobsAdapter: SourceAdapter = {
  name: "devitjobs",
  displayName: "DevITJobs.uk",
  supportsNativeTimeFilter: false,  // /api/jobsLight returns ALL jobs, no query params
  minTimeGranularityHours: null,

  async fetchJobs(keywords: string[], location: string): Promise<NewJob[]> {
    const allJobs: NewJob[] = [];
    const seenUrls = new Set<string>();
    const normalizedLocation = location.split(",")[0]?.trim().toLowerCase() ?? "london";

    try {
      const data = await getAllJobs();
      const kwLower = keywords.map(k => k.toLowerCase());

      for (const item of data) {
        // Skip paused listings
        if (item.isPaused) continue;

        const title = (item.name || "").toLowerCase();
        const techs = (item.technologies || []).map((t: string) => t.toLowerCase());
        const filterTags = (item.filterTags || []).map((t: string) => t.toLowerCase());
        const city = (item.cityCategory || item.actualCity || "").toLowerCase();
        const metaCat = (item.metaCategory || "").toLowerCase();

        // Match: keyword must appear in title, technologies, filterTags, or metaCategory
        const matchesKeyword = kwLower.some(kw =>
          title.includes(kw) ||
          techs.some((t: string) => t.includes(kw)) ||
          filterTags.some((t: string) => t.includes(kw)) ||
          metaCat.includes(kw)
        );

        if (!matchesKeyword) continue;

        // Location filter: accept if location matches or job is remote
        const isRemote = item.workplace === "remote" || item.remoteType;
        const locationMatches = city.includes(normalizedLocation) || isRemote;
        if (!locationMatches && normalizedLocation !== "") continue;

        // Build URL
        const jobUrl = item.redirectJobUrl ||
          (item.jobUrl ? `https://devitjobs.uk/jobs/${item.jobUrl}` : null);

        // Deduplicate
        if (jobUrl && seenUrls.has(jobUrl)) continue;
        if (jobUrl) seenUrls.add(jobUrl);

        // Build salary text
        let salaryText: string | null = null;
        if (item.annualSalaryFrom && item.annualSalaryTo) {
          if (item.annualSalaryFrom === item.annualSalaryTo) {
            salaryText = `£${item.annualSalaryFrom.toLocaleString()}`;
          } else {
            salaryText = `£${item.annualSalaryFrom.toLocaleString()} - £${item.annualSalaryTo.toLocaleString()}`;
          }
        }

        allJobs.push({
          companyName: item.company || "Unknown",
          jobTitle: item.name || "Untitled",
          location: item.actualCity || item.cityCategory || location,
          salaryText: salaryText || undefined,
          jdRaw: [
            `Tech: ${(item.technologies || []).join(", ")}`,
            `Type: ${item.jobType || ""} | Level: ${item.expLevel || ""}`,
            `Workplace: ${item.workplace || ""}`,
            item.hasVisaSponsorship === "Yes" ? "Visa Sponsorship: Yes" : "",
          ].filter(Boolean).join("\n"),
          applyUrl: jobUrl,
          applyType: "external",
          source: "devitjobs",
          sourceUrl: item.jobUrl ? `https://devitjobs.uk/jobs/${item.jobUrl}` : undefined,
          // NOTE: DevITJobs only has `activeFrom` — a platform batch-import timestamp
          // (multiple listings share the same second, e.g. 11:36:07.212, 11:36:02.994).
          // This is NOT a real job posting date and must NOT participate in
          // posted_date-based global sorting. Intentionally left as undefined.
          // postedDate: item.activeFrom ? new Date(item.activeFrom) : undefined,
        });
      }

      log.info(
        { total: data.length, matched: allJobs.length, keywords: keywords.join(","), location },
        "DevITJobs filtering complete"
      );
    } catch (err) {
      log.error({ err }, "DevITJobs fetch failed");
    }

    return allJobs;
  },
};
