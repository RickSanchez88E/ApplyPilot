/**
 * Reed API — Free, requires API key (basic auth).
 * 2000 requests/hour. UK job board.
 *
 * AUDIT FIX (2026-03-30): Use the details API to fetch `externalUrl` for each
 * job. The search API only returns reed.co.uk description pages, but ~40% of
 * jobs have an externalUrl pointing to the actual employer ATS (Accenture,
 * Appcast, etc.). This dramatically improves final_form discovery.
 */
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-reed" });
const BASE_URL = "https://www.reed.co.uk/api/1.0/search";
const DETAILS_URL = "https://www.reed.co.uk/api/1.0/jobs";

/** Fetch job details from Reed API to get externalUrl */
async function fetchJobDetails(
  jobId: number,
  auth: string,
): Promise<{ externalUrl?: string; jobDescription?: string } | null> {
  try {
    const res = await fetch(`${DETAILS_URL}/${jobId}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { externalUrl?: string; jobDescription?: string };
    return data;
  } catch {
    return null;
  }
}

export const reedAdapter: SourceAdapter = {
  name: "reed",
  displayName: "Reed",
  supportsNativeTimeFilter: true,
  minTimeGranularityHours: 24, // postedWithin accepts days

  async fetchJobs(keywords: string[], location: string, options?: FetchOptions): Promise<NewJob[]> {
    const apiKey = process.env.REED_API_KEY;
    if (!apiKey) {
      log.warn("REED_API_KEY not set, skipping Reed source");
      return [];
    }

    const allJobs: NewJob[] = [];
    const auth = Buffer.from(`${apiKey}:`).toString("base64");

    for (const kw of keywords) {
      try {
        const params = new URLSearchParams({
          keywords: kw,
          locationName: location.split(",")[0]?.trim() ?? "London",
          resultsToTake: "100",
        });
        // Reed supports postedWithin (integer days, minimum 1)
        if (options?.maxAgeDays) {
          params.set("postedWithin", String(Math.max(1, Math.ceil(options.maxAgeDays))));
        }

        const res = await fetch(`${BASE_URL}?${params}`, {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          log.warn({ status: res.status, kw }, "Reed API error");
          continue;
        }

        const data = (await res.json()) as { results: any[] };
        log.info({ keyword: kw, count: data.results?.length ?? 0 }, "Reed search results");

        // Fetch details in batches of 10 to get externalUrl
        const results = data.results ?? [];
        let externalUrlCount = 0;

        for (let i = 0; i < results.length; i += 10) {
          const batch = results.slice(i, i + 10);
          const details = await Promise.all(
            batch.map((item: any) =>
              item.jobId ? fetchJobDetails(item.jobId, auth) : Promise.resolve(null),
            ),
          );

          for (let j = 0; j < batch.length; j++) {
            const item = batch[j];
            const detail = details[j];
            const externalUrl = detail?.externalUrl || null;
            if (externalUrl) externalUrlCount++;

            // Use externalUrl as applyUrl when available, keep reed URL as sourceUrl
            const reedUrl = item.jobUrl ?? null;
            const enrichedDescription = detail?.jobDescription || item.jobDescription || "";

            allJobs.push({
              companyName: item.employerName ?? "Unknown",
              jobTitle: item.jobTitle ?? kw,
              location: item.locationName ?? location,
              salaryText: formatReedSalary(item.minimumSalary, item.maximumSalary),
              jdRaw: enrichedDescription || "",
              applyUrl: externalUrl ?? reedUrl,
              applyType: "external",
              source: "reed",
              sourceUrl: reedUrl,
              postedDate: parseReedDate(item.date),
            });
          }
        }

        log.info({
          keyword: kw,
          total: results.length,
          externalUrlCount,
        }, "Reed details enrichment complete");
      } catch (err) {
        log.error({ err, kw }, "Reed fetch failed");
      }
    }

    return allJobs;
  },
};


function formatReedSalary(min?: number, max?: number): string | undefined {
  if (!min && !max) return undefined;
  if (min && max) return `£${min.toLocaleString()} - £${max.toLocaleString()}`;
  if (min) return `From £${min.toLocaleString()}`;
  return `Up to £${max!.toLocaleString()}`;
}

/**
 * Reed API returns dates in DD/MM/YYYY format (UK locale).
 * JavaScript's new Date("09/02/2026") parses as MM/DD (US), producing:
 *   - "09/02/2026" → September 2 (WRONG, should be February 9)
 *   - "25/02/2026" → Invalid Date (no 25th month)
 *
 * This function explicitly parses DD/MM/YYYY → YYYY-MM-DD.
 */
function parseReedDate(raw: unknown): Date | undefined {
  if (!raw || typeof raw !== "string") return undefined;

  // Try DD/MM/YYYY
  const ddmmyyyy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return undefined;
    // Reject future dates (data integrity guard)
    if (d.getTime() > Date.now() + 86400000) return undefined;
    return d;
  }

  // Fallback: try ISO-style parsing
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.getTime() > Date.now() + 86400000) return undefined;
  return d;
}
