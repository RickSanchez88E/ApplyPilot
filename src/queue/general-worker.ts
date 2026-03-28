/**
 * General worker — processes lightweight tasks:
 *   - discover_jobs for API-based sources (Reed, DevITJobs, HN, RemoteOK)
 *   - recheck_expiry for all sources
 *
 * Entrypoint: `tsx src/queue/general-worker.ts`
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/redis.js";
import { QUEUE_NAMES, type CommandPayload, type DiscoverJobsPayload, type RecheckExpiryPayload } from "./commands.js";
import { createChildLogger } from "../lib/logger.js";
import { ALL_ADAPTERS } from "../sources/orchestrator.js";
import { dedupAndInsert } from "../ingest/dedup.js";
import { judgeExpiry } from "../domain/expiry/expiry-judge.js";
import { getJobByKey, transitionStatus, incrementMissingCount } from "../repositories/jobs-repository.js";
import { createCrawlRun, finishCrawlRun } from "../repositories/crawl-run-repository.js";
import type { ExpiryJobContext } from "../domain/expiry/types.js";

const log = createChildLogger({ module: "worker-general" });

const TIME_FILTER_TO_DAYS: Record<string, number> = {
  r86400: 1,
  r604800: 7,
  r2592000: 30,
};

export function resolveMaxAgeDays(timeFilter: string | undefined): number | undefined {
  if (!timeFilter) return undefined;
  const days = TIME_FILTER_TO_DAYS[timeFilter];
  if (days !== undefined) return days;
  // Numeric string fallback (e.g. "7" → 7)
  const parsed = Number(timeFilter);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return undefined;
}

async function handleDiscover(payload: DiscoverJobsPayload): Promise<void> {
  const adapter = ALL_ADAPTERS.find((a) => a.name === payload.source);
  if (!adapter) {
    throw new Error(`No adapter found for source: ${payload.source}`);
  }

  const runId = await createCrawlRun({ taskType: "discover_jobs", source: payload.source });

  try {
    const keywords = payload.keywords ?? ["software engineer"];
    const location = payload.location ?? "London, United Kingdom";
    const maxAgeDays = resolveMaxAgeDays(payload.timeFilter);

    log.info({ source: payload.source, keywords, location, maxAgeDays, rawTimeFilter: payload.timeFilter }, "Running discover_jobs");
    const jobs = await adapter.fetchJobs(keywords, location, maxAgeDays ? { maxAgeDays } : {});

    let inserted = 0;
    let skipped = 0;
    if (jobs.length > 0) {
      const result = await dedupAndInsert(jobs);
      inserted = result.inserted;
      skipped = result.skipped;
    }

    await finishCrawlRun(runId, {
      status: "completed",
      jobsFound: jobs.length,
      jobsInserted: inserted,
      jobsUpdated: skipped,
    });

    log.info({ source: payload.source, found: jobs.length, inserted, skipped }, "discover_jobs completed");
  } catch (err) {
    await finishCrawlRun(runId, {
      status: "failed",
      errorType: err instanceof Error ? err.constructor.name : "unknown",
      evidenceSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function handleRecheckExpiry(payload: RecheckExpiryPayload): Promise<void> {
  const job = await getJobByKey(payload.jobKey);
  if (!job) {
    log.warn({ jobKey: payload.jobKey }, "recheck_expiry: job not found in jobs_current, skipping");
    return;
  }

  const runId = await createCrawlRun({
    taskType: "recheck_expiry",
    source: payload.source,
    jobKey: payload.jobKey,
  });

  try {
    const ctx: ExpiryJobContext = {
      jobKey: job.job_key,
      source: job.source,
      applyUrl: job.apply_url,
      canonicalUrl: job.canonical_url,
      consecutiveMissingCount: job.consecutive_missing_count,
      currentStatus: job.job_status,
    };

    const decision = await judgeExpiry(ctx);
    log.info({ jobKey: payload.jobKey, decision }, "Expiry decision");

    if (decision.action === "no_change") {
      await finishCrawlRun(runId, {
        status: "completed",
        evidenceSummary: `no_change: ${decision.reason}`,
      });
      return;
    }

    // Same status as current — nothing to transition
    if (decision.action === job.job_status) {
      await finishCrawlRun(runId, {
        status: "completed",
        evidenceSummary: `already_${decision.action}: ${decision.reason}`,
      });
      return;
    }

    if (decision.action === "suspected_expired") {
      await incrementMissingCount(job.job_key);
    }

    if (decision.action === "expired" || decision.action === "suspected_expired" ||
        decision.action === "blocked" || decision.action === "fetch_failed" ||
        decision.action === "active") {
      const result = await transitionStatus(
        job.job_key,
        job.job_status,
        decision.action,
        { type: "recheck_expiry", summary: decision.reason },
      );

      if (result.updated) {
        await finishCrawlRun(runId, {
          status: "completed",
          evidenceSummary: `transitioned ${job.job_status} → ${decision.action}: ${decision.reason}`,
        });
      } else {
        // Transition was expected but DB didn't update — status drifted between read and write
        log.warn({ jobKey: job.job_key, from: job.job_status, to: decision.action }, "Transition expected but not applied — status may have drifted");
        await finishCrawlRun(runId, {
          status: "cancelled",
          evidenceSummary: `transition_not_applied: expected ${job.job_status} → ${decision.action}, but row not matched (status drift). reason: ${decision.reason}`,
        });
      }
    }
  } catch (err) {
    await finishCrawlRun(runId, {
      status: "failed",
      errorType: err instanceof Error ? err.constructor.name : "unknown",
      evidenceSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function processJob(job: Job<CommandPayload>): Promise<void> {
  const payload = job.data;
  log.info({ type: payload.type, source: payload.source, jobId: job.id }, "Processing");

  switch (payload.type) {
    case "discover_jobs":
      await handleDiscover(payload);
      break;
    case "recheck_expiry":
      await handleRecheckExpiry(payload);
      break;
    case "verify_job":
      throw new Error(`verify_job not yet implemented (jobKey=${payload.jobKey})`);
    case "enrich_job":
      throw new Error(`enrich_job not yet implemented (jobKey=${payload.jobKey})`);
    case "refresh_source_cursor":
      throw new Error(`refresh_source_cursor not yet implemented (source=${payload.source})`);
    default:
      throw new Error(`Unknown command type: ${(payload as CommandPayload).type}`);
  }
}

export function startGeneralWorker(): Worker<CommandPayload> {
  const worker = new Worker<CommandPayload>(QUEUE_NAMES.general, processJob, {
    connection: getRedisConnection(),
    concurrency: 5,
  });

  worker.on("completed", (job) => {
    log.debug({ jobId: job.id, type: job.data.type }, "Completed");
  });

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "Failed");
  });

  log.info("General worker started");
  return worker;
}

export { handleRecheckExpiry as handleRecheckExpiryForTest };
export { handleDiscover as handleDiscoverForTest };

if (process.argv[1]?.includes("general-worker")) {
  startGeneralWorker();
}
