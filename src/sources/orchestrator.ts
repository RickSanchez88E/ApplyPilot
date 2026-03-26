/**
 * Multi-source orchestrator.
 *
 * Runs all enabled adapters, applies post-filtering when needed,
 * then deduplicates and inserts the results.
 */
import { createChildLogger } from "../lib/logger.js";
import { dedupAndInsert, type DedupResult } from "../ingest/dedup.js";
import { updateProgress, incrementStat } from "../lib/progress.js";
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";

import { devitjobsAdapter } from "./devitjobs.js";
import { reedAdapter } from "./reed.js";
import { joobleAdapter } from "./jooble.js";
import { hnHiringAdapter } from "./hn-hiring.js";
import { remoteokAdapter } from "./remoteok.js";
import { syncSponsorList } from "./govuk-sponsor.js";

const log = createChildLogger({ module: "multi-source" });

export const ALL_ADAPTERS: SourceAdapter[] = [
  devitjobsAdapter,
  reedAdapter,
  joobleAdapter,
  hnHiringAdapter,
  remoteokAdapter,
];

export function getAdapterCapabilities(): Array<{
  name: string;
  displayName: string;
  supportsNativeTimeFilter: boolean;
  minTimeGranularityHours: number | null;
}> {
  return ALL_ADAPTERS.map((adapter) => ({
    name: adapter.name,
    displayName: adapter.displayName,
    supportsNativeTimeFilter: adapter.supportsNativeTimeFilter,
    minTimeGranularityHours: adapter.minTimeGranularityHours,
  }));
}

export interface MultiSourceResult {
  readonly totalFetched: number;
  readonly totalInserted: number;
  readonly totalSkipped: number;
  readonly crossPlatformDupes: number;
  readonly bySource: Record<string, { fetched: number; inserted: number }>;
  readonly sponsorSync: { totalSponsors: number; jobsUpdated: number };
  readonly durationMs: number;
}

export async function runMultiSourceScrape(
  keywords: string[],
  location: string,
  enabledSources?: string[],
  maxAgeDays?: number,
): Promise<MultiSourceResult> {
  const startTime = Date.now();
  const bySource: Record<string, { fetched: number; inserted: number }> = {};

  const adapters = enabledSources
    ? ALL_ADAPTERS.filter((adapter) => enabledSources.includes(adapter.name))
    : ALL_ADAPTERS;

  const fetchOptions: FetchOptions = maxAgeDays ? { maxAgeDays } : {};

  log.info(
    { sources: adapters.map((adapter) => adapter.name), keywords, location, maxAgeDays },
    "Starting multi-source scrape",
  );

  updateProgress({
    stage: "scraping_page",
    percent: 10,
    message: `Fetching from ${adapters.length} sources...`,
  });

  const cutoffDate = maxAgeDays
    ? new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
    : null;

  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const sourceStart = Date.now();
      try {
        log.info({ source: adapter.name }, `Fetching from ${adapter.displayName}...`);
        const jobs = await adapter.fetchJobs(keywords, location, fetchOptions);

        let filteredJobs = jobs;
        if (cutoffDate && !adapter.supportsNativeTimeFilter) {
          filteredJobs = jobs.filter((job) => {
            if (!job.postedDate) {
              log.debug(
                { source: adapter.name, title: job.jobTitle },
                "Rejecting job without postedDate during time-filtered crawl",
              );
              return false;
            }
            return job.postedDate >= cutoffDate;
          });

          if (filteredJobs.length < jobs.length) {
            log.info(
              {
                source: adapter.name,
                before: jobs.length,
                after: filteredJobs.length,
                rejected: jobs.length - filteredJobs.length,
                maxAgeDays,
              },
              "Post-filtered jobs by age",
            );
          }
        }

        log.info(
          {
            source: adapter.name,
            count: filteredJobs.length,
            durationMs: Date.now() - sourceStart,
          },
          `${adapter.displayName}: ${filteredJobs.length} jobs fetched`,
        );

        return { source: adapter.name, jobs: filteredJobs };
      } catch (err) {
        log.error({ err, source: adapter.name }, `${adapter.displayName} failed`);
        return { source: adapter.name, jobs: [] as NewJob[] };
      }
    }),
  );

  let allJobs: NewJob[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { source, jobs } = result.value;
      bySource[source] = { fetched: jobs.length, inserted: 0 };
      allJobs = allJobs.concat(jobs);
    }
  }

  const totalFetched = allJobs.length;
  log.info({ totalFetched, sources: Object.keys(bySource) }, "All sources fetched");

  updateProgress({
    stage: "dedup_insert",
    percent: 70,
    message: `Deduplicating and inserting ${totalFetched} jobs from ${adapters.length} sources...`,
  });

  let dedupResult: DedupResult = { inserted: 0, skipped: 0, crossPlatformDupes: 0 };
  if (allJobs.length > 0) {
    dedupResult = await dedupAndInsert(allJobs);
    incrementStat("jobsInserted", dedupResult.inserted);
    incrementStat("jobsSkipped", dedupResult.skipped);
  }

  updateProgress({
    stage: "ats_enhancement",
    percent: 85,
    message: "Syncing GOV.UK Visa Sponsor list...",
  });

  const sponsorSync = await syncSponsorList();
  const durationMs = Date.now() - startTime;

  updateProgress({
    stage: "completed",
    percent: 100,
    message: `Multi-source complete: ${dedupResult.inserted} new jobs from ${adapters.length} sources (${(durationMs / 1000).toFixed(1)}s)`,
  });

  log.info(
    {
      totalFetched,
      totalInserted: dedupResult.inserted,
      totalSkipped: dedupResult.skipped,
      crossPlatformDupes: dedupResult.crossPlatformDupes,
      sponsorsMatched: sponsorSync.jobsUpdated,
      durationMs,
    },
    "Multi-source scrape complete",
  );

  return {
    totalFetched,
    totalInserted: dedupResult.inserted,
    totalSkipped: dedupResult.skipped,
    crossPlatformDupes: dedupResult.crossPlatformDupes,
    bySource,
    sponsorSync,
    durationMs,
  };
}
