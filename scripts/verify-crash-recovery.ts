/**
 * verify-crash-recovery.ts
 *
 * Creates a stale running crawl_run sample and verifies crash-recovery closure.
 */

import { query, closePool } from "../src/db/client.js";
import { recoverStaleRunningCrawlRuns } from "../src/repositories/crawl-run-repository.js";

async function main(): Promise<void> {
  const staleBefore = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM public.crawl_runs
     WHERE status = 'running'
       AND started_at < NOW() - INTERVAL '30 minutes'`,
  );

  const inserted = await query<{ id: string }>(
    `INSERT INTO public.crawl_runs
      (task_type, source, status, started_at, parser_version, evidence_summary)
     VALUES
      ('resolve_apply', 'linkedin', 'running', NOW() - INTERVAL '4 hours', 'verify-crash-recovery', 'stale sample')
     RETURNING id::text`,
  );
  const insertedId = inserted.rows[0]?.id;

  const recovered = await recoverStaleRunningCrawlRuns({
    timeoutMinutes: 30,
    status: "failed",
  });

  const row = await query<{
    status: string;
    error_type: string | null;
    evidence_summary: string | null;
    finished_at: string | null;
  }>(
    `SELECT status::text, error_type, evidence_summary, finished_at::text
     FROM public.crawl_runs
     WHERE id = $1`,
    [insertedId],
  );

  console.log(
    JSON.stringify(
      {
        stale_running_before: staleBefore.rows[0]?.count ?? 0,
        inserted_id: insertedId,
        recovery_result: recovered,
        recovered_row: row.rows[0] ?? null,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error("[verify-crash-recovery] crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

