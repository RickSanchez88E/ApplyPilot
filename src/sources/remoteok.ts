/**
 * RemoteOK — Public JSON feed, no auth.
 * Remote-first tech jobs.
 */
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-remoteok" });
const FEED_URL = "https://remoteok.com/api";

export const remoteokAdapter: SourceAdapter = {
  name: "remoteok",
  displayName: "RemoteOK",
  supportsNativeTimeFilter: false,  // Public JSON feed, no query params
  minTimeGranularityHours: null,

  async fetchJobs(keywords: string[], _location: string, _options?: FetchOptions): Promise<NewJob[]> {
    try {
      const res = await fetch(FEED_URL, {
        headers: {
          "User-Agent": "job-scraper/1.0 (contact@example.com)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        log.warn({ status: res.status }, "RemoteOK API error");
        return [];
      }

      const data = (await res.json()) as any[];
      // First element is metadata, skip it
      const jobs = data.slice(1);
      const keywordsLower = keywords.map((k) => k.toLowerCase());

      const filtered = jobs.filter((j: any) => {
        const text = `${j.position ?? ""} ${j.description ?? ""} ${(j.tags ?? []).join(" ")}`.toLowerCase();
        return keywordsLower.some((kw) => text.includes(kw));
      });

      log.info({ total: jobs.length, filtered: filtered.length }, "RemoteOK results");

      return filtered.map((item: any) => ({
        companyName: item.company ?? "Unknown",
        jobTitle: item.position ?? "Remote Engineer",
        location: item.location ?? "Remote",
        workMode: "remote" as const,
        salaryText: formatRemoteOKSalary(item.salary_min, item.salary_max),
        jdRaw: (item.description ?? "").replace(/<[^>]+>/g, " "),
        applyUrl: item.url ?? item.apply_url ?? null,
        applyType: "external" as const,
        source: "remoteok" as const,
        sourceUrl: item.url ?? null,
        postedDate: item.date ? new Date(item.date) : undefined,
      }));
    } catch (err) {
      log.error({ err }, "RemoteOK fetch failed");
      return [];
    }
  },
};

function formatRemoteOKSalary(min?: number, max?: number): string | undefined {
  if (!min && !max) return undefined;
  if (min && max) return `$${min.toLocaleString()} - $${max.toLocaleString()}`;
  return undefined;
}
