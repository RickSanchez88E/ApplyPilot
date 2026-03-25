/**
 * LinkedIn Job Scraper — Condition-triggered batch worker.
 *
 * Trigger conditions (any one):
 *   1. Manual activation via CLI (--force)
 *   2. All current jobs resolved: every row state IN ('applied', 'ignored', 'suspended')
 *   3. Project init (no jobs in DB)
 *
 * Starts → scrapes → writes to DB → lifecycle ends.
 */

import { closePool, query } from "./db/client.js";
import { getConfig } from "./config.js";
import { SessionExpiredError } from "./errors.js";
import { createChildLogger } from "./logger.js";
import { dedupAndInsert } from "./dedup.js";
import { scrapeJobs } from "./linkedin-scraper.js";
import { checkSessionHealth, createSession } from "./session-manager.js";

const log = createChildLogger({ module: "main" });

export interface BatchResult {
  readonly triggered: boolean;
  readonly reason: string;
  readonly totalInserted: number;
  readonly durationMs: number;
}

export async function shouldTriggerBatch(): Promise<{ trigger: boolean; reason: string }> {
  const countResult = await query<{ total: string; unresolved: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE state NOT IN ('applied', 'ignored', 'suspended'))::text AS unresolved
     FROM jobs`,
  );

  const row = countResult.rows[0];
  const total = Number.parseInt(row?.total ?? "0", 10);
  const unresolved = Number.parseInt(row?.unresolved ?? "0", 10);

  if (total === 0) {
    return { trigger: true, reason: "project_init: no jobs in database" };
  }

  if (unresolved === 0) {
    return { trigger: true, reason: `queue_drained: all ${total} jobs resolved` };
  }

  return {
    trigger: false,
    reason: `${unresolved} of ${total} jobs still unresolved`,
  };
}

export async function runScrapeBatch(): Promise<number> {
  const config = getConfig();

  let session = createSession();
  session = await checkSessionHealth(session);

  if (!session.healthy) {
    log.error("LinkedIn session is unhealthy — aborting batch");
    return 0;
  }

  let totalInserted = 0;

  for (const keywords of config.searchKeywords) {
    try {
      log.info({ keywords }, "Starting scrape for keyword set");

      const result = await scrapeJobs(
        session,
        keywords,
        config.searchLocation,
        config.searchTimeFilter,
      );

      if (result.jobs.length > 0) {
        const dedupResult = await dedupAndInsert(result.jobs);
        totalInserted += dedupResult.inserted;

        if (dedupResult.inserted > 0) {
          await query(`SELECT pg_notify('new_job', $1)`, [
            JSON.stringify({
              inserted: dedupResult.inserted,
              keywords,
              timestamp: new Date().toISOString(),
            }),
          ]);

          log.info({ inserted: dedupResult.inserted, keywords }, "Notified new_job channel");
        }

        log.info(
          {
            keywords,
            scraped: result.jobs.length,
            inserted: dedupResult.inserted,
            skipped: dedupResult.skipped,
            pagesScraped: result.pagesScraped,
          },
          "Scrape batch complete for keyword set",
        );
      } else {
        log.info({ keywords }, "No new jobs found for keyword set");
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        log.error("Session expired — aborting remaining keyword sets this batch");
        break;
      }

      log.error({ err, keywords }, "Error during scrape for keyword set, continuing");
    }
  }

  return totalInserted;
}

export async function startScraper(options?: { force?: boolean }): Promise<BatchResult> {
  const config = getConfig();
  const force = options?.force ?? false;

  log.info(
    {
      keywords: config.searchKeywords,
      location: config.searchLocation,
      force,
    },
    "Scrape batch requested",
  );

  if (!force) {
    const { trigger, reason } = await shouldTriggerBatch();
    if (!trigger) {
      log.info({ reason }, "Batch skipped — trigger condition not met");
      return { triggered: false, reason, totalInserted: 0, durationMs: 0 };
    }
    log.info({ reason }, "Batch trigger condition met");
  }

  const cycleStart = Date.now();
  let totalInserted = 0;

  try {
    totalInserted = await runScrapeBatch();
    const durationMs = Date.now() - cycleStart;
    log.info({ totalInserted, durationMs }, "Scrape batch complete");
    return {
      triggered: true,
      reason: force ? "manual_activation" : "condition_triggered",
      totalInserted,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - cycleStart;
    log.error({ err, durationMs }, "Scrape batch failed");
    return {
      triggered: true,
      reason: `batch_error: ${err instanceof Error ? err.message : String(err)}`,
      totalInserted,
      durationMs,
    };
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  try {
    const result = await startScraper({ force });
    log.info(result, "Standalone run complete");
  } catch (err) {
    log.fatal({ err }, "Scraper crashed");
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

const isMainModule =
  typeof import.meta.url === "string" && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main();
}
