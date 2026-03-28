/**
 * Browser worker — processes heavy tasks requiring Playwright/CDP/Chrome:
 *   - discover_jobs for LinkedIn and Jooble
 *
 * Entrypoint: `tsx src/queue/browser-worker.ts`
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/redis.js";
import { QUEUE_NAMES, type CommandPayload, type DiscoverJobsPayload } from "./commands.js";
import { createChildLogger } from "../lib/logger.js";
import { runMultiSourceScrape } from "../sources/orchestrator.js";
import { startScraper } from "../index.js";
import { createCrawlRun, finishCrawlRun } from "../repositories/crawl-run-repository.js";

const log = createChildLogger({ module: "worker-browser" });

async function handleBrowserDiscover(payload: DiscoverJobsPayload): Promise<void> {
  const runId = await createCrawlRun({ taskType: "discover_jobs", source: payload.source });

  try {
    if (payload.source === "linkedin") {
      log.info({ source: "linkedin" }, "Running LinkedIn scraper via startScraper");
      const result = await startScraper({ force: true, timeFilter: payload.timeFilter });
      await finishCrawlRun(runId, {
        status: "completed",
        jobsInserted: result.totalInserted,
        evidenceSummary: result.reason,
      });
      return;
    }

    if (payload.source === "jooble") {
      const keywords = payload.keywords ?? ["software engineer"];
      const location = payload.location ?? "London, United Kingdom";
      log.info({ source: "jooble", keywords, location }, "Running Jooble scraper via orchestrator");
      const result = await runMultiSourceScrape(keywords, location, ["jooble"]);
      await finishCrawlRun(runId, {
        status: "completed",
        jobsFound: result.totalFetched,
        jobsInserted: result.totalInserted,
      });
      return;
    }

    throw new Error(`Browser discover not supported for source: ${payload.source}`);
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
  log.info({ type: payload.type, source: payload.source, jobId: job.id }, "Processing (browser)");

  switch (payload.type) {
    case "discover_jobs":
      await handleBrowserDiscover(payload);
      break;
    case "verify_job":
      throw new Error(`verify_job (browser) not yet implemented (jobKey=${payload.jobKey})`);
    case "enrich_job":
      throw new Error(`enrich_job (browser) not yet implemented (jobKey=${payload.jobKey})`);
    default:
      throw new Error(`Unexpected command type for browser worker: ${(payload as CommandPayload).type}`);
  }
}

export function startBrowserWorker(): Worker<CommandPayload> {
  const worker = new Worker<CommandPayload>(QUEUE_NAMES.browser, processJob, {
    connection: getRedisConnection(),
    concurrency: 2,
  });

  worker.on("completed", (job) => {
    log.debug({ jobId: job.id, type: job.data.type }, "Completed");
  });

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "Failed");
  });

  log.info("Browser worker started");
  return worker;
}

if (process.argv[1]?.includes("browser-worker")) {
  startBrowserWorker();
}
