/**
 * Scheduler — per-source interval-based dispatch.
 *
 * Each source has its own schedule interval, lease check, and cooldown check.
 * Does NOT run scraping directly; only dispatches commands to queues.
 * Entrypoint: `tsx src/scheduler/index.ts`
 */

import { dispatch } from "../queue/setup.js";
import { query } from "../db/client.js";
import { createChildLogger } from "../lib/logger.js";
import { getConfig } from "../shared/config.js";
import { isLeaseHeld } from "./source-lease.js";
import { isSourceInCooldown, getBreakerState } from "../browser/circuit-breaker.js";

const log = createChildLogger({ module: "scheduler" });

const EXPIRY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EXPIRY_BATCH_LIMIT = 100;

export interface SourceScheduleConfig {
  source: string;
  intervalMs: number;
}

const DEFAULT_SCHEDULES: SourceScheduleConfig[] = [
  { source: "linkedin",  intervalMs: 20 * 60 * 1000 },
  { source: "reed",      intervalMs: 30 * 60 * 1000 },
  { source: "remoteok",  intervalMs: 60 * 60 * 1000 },
  { source: "devitjobs", intervalMs: 2 * 60 * 60 * 1000 },
  { source: "hn_hiring", intervalMs: 6 * 60 * 60 * 1000 },
  { source: "jooble",    intervalMs: 4 * 60 * 60 * 1000 },
];

const sourceTimers = new Map<string, ReturnType<typeof setInterval>>();
let expiryTimer: ReturnType<typeof setInterval> | null = null;

async function canDispatch(source: string): Promise<{ ok: boolean; reason?: string }> {
  const lease = await isLeaseHeld(source);
  if (lease) {
    return { ok: false, reason: `lease held by ${lease.holder} until ${lease.expiresAt}` };
  }

  const inCooldown = await isSourceInCooldown(source);
  if (inCooldown) {
    const state = await getBreakerState(source);
    return { ok: false, reason: `cooldown until ${state.cooldownUntil}` };
  }

  return { ok: true };
}

async function dispatchForSource(source: string): Promise<void> {
  const check = await canDispatch(source);
  if (!check.ok) {
    log.debug({ source, reason: check.reason }, "Skipping scheduled dispatch");
    return;
  }

  const config = getConfig();
  try {
    const jobId = await dispatch({
      type: "discover_jobs",
      source,
      keywords: config.searchKeywords,
      location: config.searchLocation,
    });

    log.info({ source, jobId }, "Scheduled dispatch: discover_jobs");

    try {
      await query(
        `UPDATE public.source_schedule_state
         SET last_dispatched_at = NOW(), next_dispatch_at = NOW() + (interval_ms || ' milliseconds')::interval, updated_at = NOW()
         WHERE source = $1`,
        [source],
      );
    } catch { /* table may not exist */ }
  } catch (err) {
    log.error({ source, err }, "Failed to dispatch discover_jobs");
  }
}

async function dispatchExpiryChecks(): Promise<void> {
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
  const enabledSources = getConfig().enabledSources;

  log.info({ enabledSources, schedules: DEFAULT_SCHEDULES.map(s => `${s.source}:${s.intervalMs}ms`) }, "Scheduler starting with per-source intervals");

  for (const sched of DEFAULT_SCHEDULES) {
    if (!enabledSources.includes(sched.source)) {
      log.info({ source: sched.source }, "Source not enabled — skipping schedule");
      continue;
    }

    const timer = setInterval(() => {
      dispatchForSource(sched.source).catch(err =>
        log.error({ source: sched.source, err }, "Scheduled dispatch error"),
      );
    }, sched.intervalMs);
    sourceTimers.set(sched.source, timer);

    log.info({ source: sched.source, intervalMs: sched.intervalMs, intervalMin: Math.round(sched.intervalMs / 60000) }, "Source schedule registered");
  }

  expiryTimer = setInterval(() => {
    dispatchExpiryChecks().catch(err => log.error({ err }, "Expiry dispatch error"));
  }, EXPIRY_CHECK_INTERVAL_MS);

  // Initial dispatch for all sources (staggered to avoid burst)
  let delay = 0;
  for (const sched of DEFAULT_SCHEDULES) {
    if (!enabledSources.includes(sched.source)) continue;
    setTimeout(() => {
      dispatchForSource(sched.source).catch(err =>
        log.error({ source: sched.source, err }, "Initial dispatch error"),
      );
    }, delay);
    delay += 2000;
  }
}

export function stopScheduler(): void {
  for (const [source, timer] of sourceTimers) {
    clearInterval(timer);
    log.debug({ source }, "Source timer cleared");
  }
  sourceTimers.clear();
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
  log.info("Scheduler stopped");
}

export { dispatchExpiryChecks, dispatchForSource, canDispatch, DEFAULT_SCHEDULES };

if (process.argv[1]?.includes("scheduler")) {
  startScheduler();
}
