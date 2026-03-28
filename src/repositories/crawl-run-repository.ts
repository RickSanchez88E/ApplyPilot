/**
 * Repository for public.crawl_runs — per-command execution log.
 */

import { query } from "../db/client.js";

export type CrawlTaskType = "discover_jobs" | "verify_job" | "enrich_job" | "recheck_expiry" | "refresh_source_cursor" | "resolve_apply";
export type CrawlRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface CreateRunInput {
  taskType: CrawlTaskType;
  source: string;
  jobKey?: string;
  parserVersion?: string;
}

export async function createCrawlRun(input: CreateRunInput): Promise<bigint> {
  const res = await query<{ id: string }>(
    `INSERT INTO public.crawl_runs (task_type, source, job_key, parser_version)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text`,
    [input.taskType, input.source, input.jobKey ?? null, input.parserVersion ?? null],
  );
  return BigInt(res.rows[0]!.id);
}

export interface FinishRunInput {
  status: CrawlRunStatus;
  httpStatus?: number;
  errorType?: string;
  evidenceSummary?: string;
  jobsFound?: number;
  jobsInserted?: number;
  jobsUpdated?: number;
}

export async function finishCrawlRun(runId: bigint, input: FinishRunInput): Promise<void> {
  await query(
    `UPDATE public.crawl_runs SET
       status = $2,
       http_status = $3,
       error_type = $4,
       evidence_summary = $5,
       jobs_found = $6,
       jobs_inserted = $7,
       jobs_updated = $8,
       finished_at = NOW(),
       duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
     WHERE id = $1`,
    [
      runId.toString(),
      input.status,
      input.httpStatus ?? null,
      input.errorType ?? null,
      input.evidenceSummary ?? null,
      input.jobsFound ?? null,
      input.jobsInserted ?? null,
      input.jobsUpdated ?? null,
    ],
  );
}

export async function recoverStaleRunningCrawlRuns(input?: {
  timeoutMinutes?: number;
  status?: Extract<CrawlRunStatus, "failed" | "cancelled">;
}): Promise<{ recovered: number; timeoutMinutes: number; status: "failed" | "cancelled" }> {
  const timeoutMinutes = Math.max(input?.timeoutMinutes ?? 180, 1);
  const status: "failed" | "cancelled" = input?.status === "cancelled" ? "cancelled" : "failed";
  const result = await query<{ recovered: number }>(
    `WITH stale AS (
       SELECT id
       FROM public.crawl_runs
       WHERE status = 'running'
         AND started_at < NOW() - ($1::text || ' minutes')::interval
     )
     UPDATE public.crawl_runs cr
     SET
       status = $2,
       finished_at = NOW(),
       duration_ms = EXTRACT(EPOCH FROM (NOW() - cr.started_at))::int * 1000,
       error_type = COALESCE(cr.error_type, 'worker_crash_recovery'),
       evidence_summary = CASE
         WHEN cr.evidence_summary IS NULL OR btrim(cr.evidence_summary) = ''
           THEN 'Recovered stale running run by crash-recovery policy'
         ELSE cr.evidence_summary || ' | recovered_by=crash_recovery'
       END
     FROM stale
     WHERE cr.id = stale.id
     RETURNING 1`,
    [String(timeoutMinutes), status],
  );

  return {
    recovered: result.rowCount ?? 0,
    timeoutMinutes,
    status,
  };
}
