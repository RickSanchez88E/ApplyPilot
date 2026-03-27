/**
 * Backfill employer apply URLs for existing src_jooble.jobs rows by re-opening each
 * Jooble /desc/ page in CDP and parsing the outbound link (cf-bypass-scraper: one tab,
 * one persistent session — same as live scrape keyword path).
 *
 * Usage:
 *   npx tsx scripts/backfill-jooble-apply-urls.ts [--limit=30] [--dry-run] [--keep-expired]
 *
 * Env:
 *   JOOBLE_BACKFILL_DELAY_MS — delay between /desc/ requests (default 3500; lowers CF rate-limit risk)
 *   JOOBLE_DESC_FETCH_DELAY_MS — fallback if BACKFILL not set
 *   DATABASE_URL — PostgreSQL connection string
 */
import "dotenv/config";
import { query, closePool } from "../src/db/client.js";
import {
  isExternalEmployerApplyUrl,
  scrapeJoobleDescOnPage,
} from "../src/sources/jooble-browser.js";
import { closeCdpPool, withCdpTab } from "../src/lib/cdp-pool.js";
import { createChildLogger } from "../src/lib/logger.js";

const log = createChildLogger({ module: "backfill-jooble-apply" });

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseLimit(): number {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (arg) {
    const n = Number.parseInt(arg.split("=")[1] ?? "", 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 500);
  }
  const def = process.env.JOOBLE_BACKFILL_LIMIT;
  if (def) {
    const n = Number.parseInt(def, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 500);
  }
  return 30;
}

function getBackfillDelayMs(): number {
  const raw = process.env.JOOBLE_BACKFILL_DELAY_MS ?? process.env.JOOBLE_DESC_FETCH_DELAY_MS;
  const n = raw ? Number.parseInt(raw, 10) : 3500;
  if (!Number.isFinite(n) || n < 0) return 3500;
  return Math.min(n, 60_000);
}

async function deleteContentIndexRow(jobId: string | number): Promise<void> {
  await query(`DELETE FROM public.content_index WHERE source = $1 AND source_job_id = $2`, [
    "jooble",
    jobId,
  ]);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const deleteExpired = !process.argv.includes("--keep-expired");
  const limit = parseLimit();
  const descDelay = getBackfillDelayMs();

  log.info({ limit, dryRun, deleteExpired, descDelayMs: descDelay }, "Jooble apply_url backfill start");

  const sel = await query<{
    id: string;
    job_title: string;
    source_url: string;
    apply_url: string | null;
  }>(
    `SELECT id, job_title, source_url, apply_url
     FROM src_jooble.jobs
     WHERE source_url IS NOT NULL
       AND source_url LIKE '%/desc/%'
       AND (
         apply_url IS NULL
         OR TRIM(apply_url) = ''
         OR apply_url ILIKE '%jooble.org%'
         OR apply_url ILIKE '%jooble.com%'
       )
     ORDER BY id ASC
     LIMIT $1`,
    [limit],
  );

  const rows = sel.rows;
  log.info({ candidates: rows.length }, "Rows to process");

  let updated = 0;
  let expiredDeleted = 0;
  let failed = 0;
  let noExternalLink = 0;
  let thrown = 0;

  if (dryRun) {
    for (const row of rows) {
      console.log(`[dry-run] would scrape id=${row.id} ${row.job_title.slice(0, 50)}`);
    }
  } else {
    await withCdpTab(async (page) => {
      for (const row of rows) {
        const id = row.id;
        const sourceUrl = row.source_url.trim();

        let outcome: Awaited<ReturnType<typeof scrapeJoobleDescOnPage>>;
        try {
          outcome = await scrapeJoobleDescOnPage(page, sourceUrl);
        } catch (err) {
          thrown++;
          log.error({ id: String(id), err }, "scrapeJoobleDescOnPage threw; continuing");
          await delay(descDelay);
          continue;
        }

        if (!outcome.ok) {
          if (outcome.expired && deleteExpired) {
            await deleteContentIndexRow(id);
            await query(`DELETE FROM src_jooble.jobs WHERE id = $1`, [id]);
            expiredDeleted++;
            log.info({ id: String(id), title: row.job_title.slice(0, 40) }, "Deleted expired Jooble row");
          } else {
            failed++;
            log.warn(
              { id: String(id), reason: outcome.reason, expired: outcome.expired },
              "Desc scrape did not succeed",
            );
          }
          await delay(descDelay);
          continue;
        }

        const external = outcome.detail.applyUrl.trim();
        if (isExternalEmployerApplyUrl(external)) {
          await query(
            `UPDATE src_jooble.jobs
             SET apply_url = $1, updated_at = NOW()
             WHERE id = $2`,
            [external, id],
          );
          updated++;
          log.info({ id: String(id), apply: external.slice(0, 80) }, "Updated apply_url");
        } else {
          noExternalLink++;
          log.warn({ id: String(id), title: row.job_title.slice(0, 40) }, "No external apply URL found on desc page");
        }

        await delay(descDelay);
      }
    });
  }

  log.info(
    {
      processed: rows.length,
      updated,
      expiredDeleted,
      failed,
      noExternalLink,
      thrown,
      dryRun,
    },
    "Jooble apply_url backfill complete",
  );

  console.log(
    JSON.stringify(
      {
        candidates: rows.length,
        updated,
        expiredDeleted,
        failed,
        noExternalLink,
        thrown,
        dryRun,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    log.error({ err }, "backfill failed");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCdpPool();
    await closePool();
  });
