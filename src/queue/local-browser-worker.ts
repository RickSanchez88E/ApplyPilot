/**
 * Local browser worker — runs on the HOST machine (not in Docker).
 * Uses the local persistent Chrome profile for:
 *   - Jooble discover_jobs (slow mode via jooble-local.ts)
 *   - resolve_apply for any source needing real browser + login state
 *
 * P0 guarantees:
 *   - Worker concurrency is configurable but defaults to 1
 *   - Page lifecycle is tracked by PageLifecycleTracker (semaphore-enforced)
 *   - Every page is closed in finally (via withLocalPage)
 *   - Lifecycle stats are logged after each task
 *
 * Entrypoint: `tsx src/queue/local-browser-worker.ts`
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/redis.js";
import {
  QUEUE_NAMES,
  type CommandPayload,
  type DiscoverJobsPayload,
  type ResolveApplyPayload,
} from "./commands.js";
import { createChildLogger } from "../lib/logger.js";
import { createCrawlRun, finishCrawlRun } from "../repositories/crawl-run-repository.js";
import {
  withLocalPage,
  withSourceLease,
  destroyOnBreaker,
  getLifecycleStats,
} from "../browser/local-browser-manager.js";
import { recordFailure, type FailureType } from "../browser/circuit-breaker.js";
import { resolveApplyUrl } from "../domain/apply-discovery/apply-resolver.js";
import { upsertApplyDiscovery } from "../repositories/apply-discovery-repository.js";
import { scrapeJoobleLocal } from "../sources/jooble-local.js";
import { getSourceConcurrency } from "../browser/source-concurrency.js";
import { appendLog, incrementStat, resetProgress, updateProgress } from "../lib/progress.js";

const log = createChildLogger({ module: "worker-local-browser" });

const WORKER_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.LOCAL_BROWSER_WORKER_CONCURRENCY ?? "1", 10),
);

async function handleJoobleDiscover(payload: DiscoverJobsPayload): Promise<void> {
  const runId = await createCrawlRun({ taskType: "discover_jobs", source: "jooble" });
  const keywords = payload.keywords ?? ["software engineer"];
  const location = payload.location ?? "London, United Kingdom";

  resetProgress();
  updateProgress({
    source: "jooble",
    stage: "initializing",
    percent: 0,
    message: "Jooble run queued",
    keyword: keywords.join(", "),
  });
  appendLog("info", "Jooble run started", {
    source: "jooble",
    stage: "initializing",
    percent: 2,
  });

  try {
    await withSourceLease("jooble", "local-browser-worker", async () => {
      log.info({
        keywords,
        location,
        hardCap: process.env.JOOBLE_DESC_HARD_CAP ?? "20",
        mode: "local-persistent-browser",
      }, "Jooble discover - using local persistent Chrome (NOT proxy/CDP pool)");
      appendLog("info", `Lease acquired, crawling Jooble (${location})`, {
        source: "jooble",
        stage: "scraping_page",
        percent: 6,
      });

      const jobs = await scrapeJoobleLocal(keywords, location);
      appendLog("info", `Desc crawl complete: ${jobs.length} candidates`, {
        source: "jooble",
        stage: "dedup_insert",
        percent: 72,
      });

      const { dedupAndInsert } = await import("../ingest/dedup.js");
      let inserted = 0;
      let skipped = 0;
      if (jobs.length > 0) {
        const result = await dedupAndInsert(jobs);
        inserted = result.inserted;
        skipped = result.skipped;
        incrementStat("jobsInserted", inserted);
        incrementStat("jobsSkipped", skipped);
      }

      await finishCrawlRun(runId, {
        status: "completed",
        jobsFound: jobs.length,
        jobsInserted: inserted,
        jobsUpdated: skipped,
      });

      log.info({ found: jobs.length, inserted, skipped, mode: "local-persistent-browser" }, "Jooble discover completed");
      appendLog("success", `Jooble completed: ${inserted} inserted, ${skipped} skipped`, {
        source: "jooble",
        stage: "completed",
        percent: 100,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isCfBlock = message.includes("Cloudflare") || message.includes("challenge");
    const failureType: FailureType = isCfBlock ? "cf_block" : "timeout";

    await recordFailure("jooble", failureType);

    if (isCfBlock) {
      log.warn("Jooble CF block - triggering breaker destroy");
      await destroyOnBreaker("jooble", "cf_block");
    }

    await finishCrawlRun(runId, {
      status: "failed",
      errorType: err instanceof Error ? err.constructor.name : "unknown",
      evidenceSummary: message,
    });
    appendLog("error", `Jooble failed: ${message}`, {
      source: "jooble",
      stage: "error",
      percent: 0,
    });
    throw err;
  }
}

async function handleResolveApply(payload: ResolveApplyPayload): Promise<void> {
  const sourceConfig = getSourceConcurrency(payload.source);
  const runId = await createCrawlRun({
    taskType: "resolve_apply",
    source: payload.source,
    jobKey: payload.jobKey,
  });

  try {
    await withSourceLease(payload.source, "local-browser-worker", async () => {
      const result = await withLocalPage(payload.source, async (page) => {
        return resolveApplyUrl(page, payload.applyUrl, payload.source, {
          timeoutMs: sourceConfig.navigationTimeoutMs,
        });
      });

      await upsertApplyDiscovery(
        payload.jobKey,
        payload.source,
        result,
        payload.sourceDescUrl,
        payload.applyUrl,
      );

      await finishCrawlRun(runId, {
        status: "completed",
        evidenceSummary: `apply_discovery: ${result.status}${result.formProvider ? ` (${result.formProvider})` : ""}`,
      });

      log.info({
        jobKey: payload.jobKey,
        status: result.status,
        formProvider: result.formProvider,
        finalFormUrl: result.finalFormUrl,
      }, "Apply resolution completed");
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishCrawlRun(runId, {
      status: "failed",
      errorType: err instanceof Error ? err.constructor.name : "unknown",
      evidenceSummary: message,
    });
    throw err;
  }
}

async function processJob(job: Job<CommandPayload>): Promise<void> {
  const payload = job.data;
  log.info({ type: payload.type, source: payload.source, jobId: job.id }, "Processing (local-browser)");

  switch (payload.type) {
    case "discover_jobs":
      if (payload.source === "jooble") {
        await handleJoobleDiscover(payload);
      } else {
        throw new Error(`Local browser discover not supported for source: ${payload.source}`);
      }
      break;
    case "resolve_apply":
      await handleResolveApply(payload);
      break;
    default:
      throw new Error(`Unexpected command type for local browser worker: ${payload.type}`);
  }

  // P0: Log lifecycle stats after every task
  const stats = getLifecycleStats();
  log.info(
    {
      openPages: stats.pages.openPages,
      closedPages: stats.pages.closedPages,
      leakedPages: stats.pages.leakedPages,
      highWaterMark: stats.pages.highWaterMark,
      rssMB: Math.round(stats.pages.lastMemoryRss / 1024 / 1024),
      browserAlive: stats.browser.alive,
    },
    "Post-task lifecycle stats",
  );
}

export function startLocalBrowserWorker(): Worker<CommandPayload> {
  const worker = new Worker<CommandPayload>(QUEUE_NAMES.localBrowser, processJob, {
    connection: getRedisConnection(),
    concurrency: WORKER_CONCURRENCY,
  });

  worker.on("completed", (job) => {
    log.debug({ jobId: job.id, type: job.data.type }, "Completed");
  });

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "Failed");
    // P0: Log lifecycle stats on failure too
    const stats = getLifecycleStats();
    log.warn(
      {
        openPages: stats.pages.openPages,
        leakedPages: stats.pages.leakedPages,
        rssMB: Math.round(stats.pages.lastMemoryRss / 1024 / 1024),
      },
      "Post-failure lifecycle stats",
    );
  });

  log.info(
    {
      concurrency: WORKER_CONCURRENCY,
      maxOpenPages: parseInt(process.env.MAX_OPEN_PAGES ?? "3", 10),
      maxOpenPagesPerSource: parseInt(process.env.MAX_OPEN_PAGES_PER_SOURCE ?? "2", 10),
    },
    "Local browser worker started (host process) with lifecycle tracking",
  );
  return worker;
}

if (process.argv[1]?.includes("local-browser-worker")) {
  startLocalBrowserWorker();
}

