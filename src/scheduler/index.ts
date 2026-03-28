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
import { dispatchApplyDiscoveryBackfill } from "../domain/apply-discovery/dispatch.js";
import { recoverStaleRunningCrawlRuns } from "../repositories/crawl-run-repository.js";

const log = createChildLogger({ module: "scheduler" });

const EXPIRY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EXPIRY_BATCH_LIMIT = 100;
const APPLY_DISCOVERY_BACKFILL_INTERVAL_MS =
  parseInt(process.env.APPLY_BACKFILL_INTERVAL_MS ?? String(10 * 60 * 1000), 10);
const APPLY_DISCOVERY_BACKFILL_LIMIT =
  parseInt(process.env.APPLY_BACKFILL_LIMIT ?? "30", 10);
const CRAWL_RUN_RECOVERY_INTERVAL_MS =
  parseInt(process.env.CRAWL_RUN_RECOVERY_INTERVAL_MS ?? String(15 * 60 * 1000), 10);
const CRAWL_RUN_RECOVERY_TIMEOUT_MINUTES =
  parseInt(process.env.CRAWL_RUN_RECOVERY_TIMEOUT_MINUTES ?? "180", 10);
const CRAWL_RUN_RECOVERY_STATUS =
  process.env.CRAWL_RUN_RECOVERY_STATUS === "cancelled" ? "cancelled" : "failed";

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
let applyDiscoveryBackfillTimer: ReturnType<typeof setInterval> | null = null;
let crawlRunRecoveryTimer: ReturnType<typeof setInterval> | null = null;

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

/**
 * Per-source round-robin index for apply discovery backfill.
 * Rotates through sources to avoid overloading any single source.
 */
let applyBackfillSourceIdx = 0;

const DEFAULT_BACKFILL_SOURCE_CAPS: Record<string, number> = {
  jooble: 3,
  linkedin: 4,
  reed: 1,
  remoteok: 1,
  hn_hiring: 8,
  devitjobs: 8,
};

function parseBackfillSourceCaps(): Record<string, number> {
  const raw = process.env.APPLY_BACKFILL_SOURCE_LIMITS;
  if (!raw) return DEFAULT_BACKFILL_SOURCE_CAPS;
  const parsed: Record<string, number> = { ...DEFAULT_BACKFILL_SOURCE_CAPS };
  for (const entry of raw.split(",")) {
    const [sourceRaw, capRaw] = entry.split(":");
    const source = sourceRaw?.trim();
    const cap = Number.parseInt(capRaw?.trim() ?? "", 10);
    if (!source || !Number.isFinite(cap) || cap < 1) continue;
    parsed[source] = cap;
  }
  return parsed;
}

async function recoverStaleRunsTick(): Promise<void> {
  const result = await recoverStaleRunningCrawlRuns({
    timeoutMinutes: CRAWL_RUN_RECOVERY_TIMEOUT_MINUTES,
    status: CRAWL_RUN_RECOVERY_STATUS,
  });
  if (result.recovered > 0) {
    log.warn(
      { recovered: result.recovered, timeoutMinutes: result.timeoutMinutes, status: result.status },
      "Recovered stale running crawl runs",
    );
  } else {
    log.debug({ timeoutMinutes: result.timeoutMinutes, status: result.status }, "No stale crawl runs to recover");
  }
}

async function dispatchApplyDiscoveryBackfillTick(enabledSources: string[]): Promise<void> {
  try {
    const sources = enabledSources.filter(Boolean);
    if (sources.length === 0) {
      log.warn("No enabled sources for apply discovery backfill tick");
      return;
    }

    let remainingGlobalLimit = Math.max(APPLY_DISCOVERY_BACKFILL_LIMIT, 1);
    let scanned = 0;
    let totalCandidates = 0;
    let totalDispatched = 0;
    let totalLoginPending = 0;
    const sourceCaps = parseBackfillSourceCaps();

    while (remainingGlobalLimit > 0 && scanned < sources.length) {
      const source = sources[applyBackfillSourceIdx % sources.length];
      applyBackfillSourceIdx++;
      scanned++;
      if (!source) {
        continue;
      }

      const cap = sourceCaps[source] ?? remainingGlobalLimit;
      const limit = Math.min(cap, remainingGlobalLimit);
      if (limit <= 0) continue;

      const result = await dispatchApplyDiscoveryBackfill({ source, limit });
      totalCandidates += result.candidates;
      totalDispatched += result.dispatched;
      totalLoginPending += result.loginPending;
      remainingGlobalLimit -= result.dispatched;

      log.debug(
        {
          source,
          requestLimit: limit,
          candidates: result.candidates,
          dispatched: result.dispatched,
          loginPending: result.loginPending,
          remainingGlobalLimit,
        },
        "Apply backfill per-source tick result",
      );
    }

    if (totalDispatched > 0 || totalLoginPending > 0) {
      log.info(
        {
          globalLimit: APPLY_DISCOVERY_BACKFILL_LIMIT,
          totalCandidates,
          totalDispatched,
          totalLoginPending,
          scannedSources: Math.min(scanned, sources.length),
        },
        "Scheduled dispatch: apply discovery backfill (global-limit round-robin)",
      );
    } else {
      log.debug({ scannedSources: Math.min(scanned, sources.length) }, "No apply discovery backfill candidates");
    }
  } catch (err) {
    log.error({ err }, "Failed to dispatch apply discovery backfill tick");
  }
}

export function startScheduler(): void {
  const enabledSources = getConfig().enabledSources;
  const backfillSources = DEFAULT_SCHEDULES
    .map((x) => x.source)
    .filter((source) => enabledSources.includes(source));

  log.info(
    {
      enabledSources,
      schedules: DEFAULT_SCHEDULES.map((s) => `${s.source}:${s.intervalMs}ms`),
      applyBackfill: {
        intervalMs: APPLY_DISCOVERY_BACKFILL_INTERVAL_MS,
        globalLimitPerTick: APPLY_DISCOVERY_BACKFILL_LIMIT,
        sourceCaps: parseBackfillSourceCaps(),
      },
      crashRecovery: {
        intervalMs: CRAWL_RUN_RECOVERY_INTERVAL_MS,
        timeoutMinutes: CRAWL_RUN_RECOVERY_TIMEOUT_MINUTES,
        recoveryStatus: CRAWL_RUN_RECOVERY_STATUS,
      },
    },
    "Scheduler starting with per-source intervals",
  );

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

  applyDiscoveryBackfillTimer = setInterval(() => {
    dispatchApplyDiscoveryBackfillTick(backfillSources).catch(err => log.error({ err }, "Apply discovery dispatch error"));
  }, APPLY_DISCOVERY_BACKFILL_INTERVAL_MS);
  crawlRunRecoveryTimer = setInterval(() => {
    recoverStaleRunsTick().catch((err) => log.error({ err }, "Crawl run recovery error"));
  }, CRAWL_RUN_RECOVERY_INTERVAL_MS);

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

  setTimeout(() => {
    dispatchApplyDiscoveryBackfillTick(backfillSources).catch(err => log.error({ err }, "Initial apply discovery dispatch error"));
  }, 3000);
  setTimeout(() => {
    recoverStaleRunsTick().catch((err) => log.error({ err }, "Initial crawl run recovery error"));
  }, 1000);
}

export function stopScheduler(): void {
  for (const [source, timer] of sourceTimers) {
    clearInterval(timer);
    log.debug({ source }, "Source timer cleared");
  }
  sourceTimers.clear();
  if (expiryTimer) clearInterval(expiryTimer);
  if (applyDiscoveryBackfillTimer) clearInterval(applyDiscoveryBackfillTimer);
  if (crawlRunRecoveryTimer) clearInterval(crawlRunRecoveryTimer);
  expiryTimer = null;
  applyDiscoveryBackfillTimer = null;
  crawlRunRecoveryTimer = null;
  log.info("Scheduler stopped");
}

export { dispatchExpiryChecks, dispatchForSource, canDispatch, DEFAULT_SCHEDULES };

if (process.argv[1]?.includes("scheduler")) {
  startScheduler();
}
