/**
 * Source adapter interface — all data sources implement this.
 *
 * AUDIT (2026-03-26): Added capability declarations so orchestrator and UI
 * can distinguish real API-level time filtering from post-filter workarounds.
 */
import type { NewJob, JobSource } from "../shared/types.js";

export interface FetchOptions {
  /** Maximum age of listings in days. Only sources with
   *  `supportsNativeTimeFilter = true` will pass this to their API.
   *  Others receive the full feed and are post-filtered. */
  readonly maxAgeDays?: number;
}

export interface SourceAdapter {
  readonly name: JobSource;
  readonly displayName: string;

  /**
   * Whether this source's API natively supports a time/date filter parameter
   * that constrains the _server-side_ result set before it reaches us.
   *
   * `true`  = time param enters the HTTP request and limits results (Reed, Jooble)
   * `false` = we fetch the full feed and post-filter locally (DevITJobs, RemoteOK, HN)
   */
  readonly supportsNativeTimeFilter: boolean;

  /**
   * Minimum granularity the source API can filter by, in hours.
   * `null` = source does not support time filtering at all.
   * `24`   = can filter by day (Reed postedWithin, Jooble datecreatedfrom).
   */
  readonly minTimeGranularityHours: number | null;

  /** Fetch jobs from this source */
  fetchJobs(keywords: string[], location: string, options?: FetchOptions): Promise<NewJob[]>;
}
