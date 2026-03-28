/**
 * Local browser worker — runs on the HOST machine (not in Docker).
 * Uses the local persistent Chrome profile for:
 *   - Jooble discover_jobs (slow mode, concurrency=1)
 *   - resolve_apply for any source needing real browser + login state
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
} from "../browser/local-browser-manager.js";
import { recordFailure, recordSuccess, type FailureType } from "../browser/circuit-breaker.js";
import { resolveApplyUrl } from "../domain/apply-discovery/apply-resolver.js";
import { upsertApplyDiscovery } from "../repositories/apply-discovery-repository.js";

const log = createChildLogger({ module: "worker-local-browser" });

// Jooble hard cap config — used by jooble adapter via env var

async function handleJoobleDiscover(payload: DiscoverJobsPayload): Promise<void> {
  const runId = await createCrawlRun({ taskType: "discover_jobs", source: "jooble" });

  try {
    await withSourceLease("jooble", "local-browser-worker", async () => {
      const keywords = payload.keywords ?? ["software engineer"];
      const location = payload.location ?? "London, United Kingdom";

      log.info({ keywords, location, hardCap: process.env.JOOBLE_DESC_HARD_CAP ?? "20" }, "Jooble local browser slow-mode discover");

      const { joobleAdapter } = await import("../sources/jooble.js");
      const jobs = await joobleAdapter.fetchJobs(keywords, location, {});

      const { dedupAndInsert } = await import("../ingest/dedup.js");
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

      log.info({ found: jobs.length, inserted, skipped }, "Jooble discover completed");
      await recordSuccess("jooble");
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isCfBlock = message.includes("Cloudflare") || message.includes("challenge");
    const failureType: FailureType = isCfBlock ? "cf_block" : "timeout";

    await recordFailure("jooble", failureType);

    if (isCfBlock) {
      log.warn("Jooble CF block detected — triggering breaker destroy");
      await destroyOnBreaker("jooble", "cf_block");
    }

    await finishCrawlRun(runId, {
      status: "failed",
      errorType: err instanceof Error ? err.constructor.name : "unknown",
      evidenceSummary: message,
    });
    throw err;
  }
}

async function handleResolveApply(payload: ResolveApplyPayload): Promise<void> {
  const runId = await createCrawlRun({
    taskType: "resolve_apply",
    source: payload.source,
    jobKey: payload.jobKey,
  });

  try {
    const result = await withLocalPage(payload.source, async (page) => {
      return resolveApplyUrl(page, payload.applyUrl, payload.source);
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
}

export function startLocalBrowserWorker(): Worker<CommandPayload> {
  const worker = new Worker<CommandPayload>(QUEUE_NAMES.localBrowser, processJob, {
    connection: getRedisConnection(),
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    log.debug({ jobId: job.id, type: job.data.type }, "Completed");
  });

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "Failed");
  });

  log.info({ concurrency: 1 }, "Local browser worker started (host process)");
  return worker;
}

if (process.argv[1]?.includes("local-browser-worker")) {
  startLocalBrowserWorker();
}
