/**
 * Scheduler — creates recurring commands via interval timers.
 *
 * Does NOT run scraping directly; only dispatches commands to queues.
 * Entrypoint: `tsx src/scheduler/index.ts`
 */

import { dispatch } from "../queue/setup.js";
import { query } from "../db/client.js";
import { createChildLogger } from "../lib/logger.js";
import { getConfig } from "../shared/config.js";

const log = createChildLogger({ module: "scheduler" });

const DISCOVER_INTERVAL_MS = 30 * 60 * 1000;
const EXPIRY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EXPIRY_BATCH_LIMIT = 100;

let discoverTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setInterval> | null = null;

async function dispatchDiscoverAll(): Promise<void> {
  const config = getConfig();
  const sources = config.enabledSources;
  log.info({ sources }, "Dispatching discover_jobs for all enabled sources");

  for (const source of sources) {
    try {
      const jobId = await dispatch({
        type: "discover_jobs",
        source,
        keywords: config.searchKeywords,
        location: config.searchLocation,
      });
      log.info({ source, jobId }, "Dispatched discover_jobs");
    } catch (err) {
      log.error({ source, err }, "Failed to dispatch discover_jobs");
    }
  }
}

async function dispatchExpiryChecks(): Promise<void> {
  // Candidates:
  // 1. suspected_expired jobs — need re-verification
  // 2. active jobs not seen in 48+ hours — may have gone stale
  // 3. blocked jobs with cooldown > 6 hours — retry
  const candidates = await query<{ job_key: string; source: string }>(
    `SELECT job_key, source FROM public.jobs_current
     WHERE
       (job_status = 'suspected_expired')
       OR (job_status = 'active' AND last_seen_at < NOW() - INTERVAL '48 hours')
       OR (job_status = 'blocked' AND last_evidence_at < NOW() - INTERVAL '6 hours')
     ORDER BY last_seen_at ASC NULLS FIRST
     LIMIT $1`,
    [EXPIRY_BATCH_LIMIT],
  );

  if (candidates.rows.length === 0) {
    log.info("No expiry recheck candidates found");
    return;
  }

  log.info({ count: candidates.rows.length }, "Dispatching recheck_expiry commands");

  let dispatched = 0;
  for (const row of candidates.rows) {
    try {
      await dispatch({
        type: "recheck_expiry",
        jobKey: row.job_key,
        source: row.source,
      });
      dispatched++;
    } catch (err) {
      log.error({ jobKey: row.job_key, err }, "Failed to dispatch recheck_expiry");
    }
  }

  log.info({ dispatched, total: candidates.rows.length }, "Expiry dispatch complete");
}

export function startScheduler(): void {
  log.info(
    { discoverIntervalMs: DISCOVER_INTERVAL_MS, expiryIntervalMs: EXPIRY_CHECK_INTERVAL_MS },
    "Scheduler started",
  );

  discoverTimer = setInterval(() => {
    dispatchDiscoverAll().catch((err) => log.error({ err }, "Discover dispatch error"));
  }, DISCOVER_INTERVAL_MS);

  expiryTimer = setInterval(() => {
    dispatchExpiryChecks().catch((err) => log.error({ err }, "Expiry dispatch error"));
  }, EXPIRY_CHECK_INTERVAL_MS);

  dispatchDiscoverAll().catch((err) => log.error({ err }, "Initial discover dispatch error"));
}

export function stopScheduler(): void {
  if (discoverTimer) clearInterval(discoverTimer);
  if (expiryTimer) clearInterval(expiryTimer);
  discoverTimer = null;
  expiryTimer = null;
  log.info("Scheduler stopped");
}

// Exported for testing
export { dispatchExpiryChecks, dispatchDiscoverAll };

if (process.argv[1]?.includes("scheduler")) {
  startScheduler();
}
