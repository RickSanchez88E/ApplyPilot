import { getPool, query } from "../../db/client.js";
import { createChildLogger } from "../../lib/logger.js";
import { purgeDeadLetterRecords, runDeadLetterScan, type DeadLetterResult } from "../../db/dead-letter.js";

const log = createChildLogger({ module: "dead-letter-maintenance" });
const DLQ_LOCK_KEY = 1_684_443;
const JOB_NAME = "dead_letter_scan";

export interface RunDeadLetterMaintenanceOptions {
  batchSize?: number;
  sources?: string[];
  force?: boolean;
  intervalMs?: number;
  trigger?: "manual" | "interval" | "startup";
}

export type DeadLetterMaintenanceStatus = "executed" | "skipped_lock" | "skipped_not_due";

export interface DeadLetterMaintenanceResult {
  status: DeadLetterMaintenanceStatus;
  detail?: {
    scanned: DeadLetterResult;
    purged: number;
    nextRunAt: string;
    trigger: string;
  };
}

interface MaintenanceJobRow {
  next_run_at: Date;
}

async function ensureMaintenanceJob(intervalMs: number): Promise<void> {
  await query(
    `INSERT INTO public.maintenance_jobs (job_name, next_run_at, last_status)
     VALUES ($1, NOW(), 'idle')
     ON CONFLICT (job_name) DO NOTHING`,
    [JOB_NAME],
  );

  if (intervalMs > 0) {
    await query(
      `UPDATE public.maintenance_jobs
       SET interval_ms = $2
       WHERE job_name = $1`,
      [JOB_NAME, intervalMs],
    );
  }
}

export async function runDeadLetterMaintenance(
  options: RunDeadLetterMaintenanceOptions = {},
): Promise<DeadLetterMaintenanceResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 200, 1), 500);
  const force = options.force ?? false;
  const intervalMs = Math.max(options.intervalMs ?? 6 * 60 * 60 * 1000, 60_000);
  const trigger = options.trigger ?? "interval";
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMaintenanceJob(intervalMs);

    const lockRes = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [DLQ_LOCK_KEY]);
    if (!lockRes.rows[0]?.ok) {
      return { status: "skipped_lock" };
    }

    const claim = await client.query<MaintenanceJobRow>(
      `UPDATE public.maintenance_jobs
       SET last_started_at = NOW(),
           last_finished_at = NULL,
           last_error = NULL,
           last_status = 'running'
       WHERE job_name = $1
         AND ($2::boolean = TRUE OR next_run_at <= NOW())
       RETURNING next_run_at`,
      [JOB_NAME, force],
    );

    if (claim.rowCount === 0) {
      return { status: "skipped_not_due" };
    }

    const scanned = await runDeadLetterScan(batchSize, options.sources);
    const purged = await purgeDeadLetterRecords();

    const next = await client.query<{ next_run_at: Date }>(
      `UPDATE public.maintenance_jobs
       SET last_finished_at = NOW(),
           last_status = 'success',
           next_run_at = NOW() + ($2 || ' milliseconds')::interval
       WHERE job_name = $1
       RETURNING next_run_at`,
      [JOB_NAME, String(intervalMs)],
    );

    const nextRunAt = next.rows[0]?.next_run_at?.toISOString() ?? new Date(Date.now() + intervalMs).toISOString();
    return {
      status: "executed",
      detail: {
        scanned,
        purged,
        nextRunAt,
        trigger,
      },
    };
  } catch (err) {
    await client.query(
      `UPDATE public.maintenance_jobs
       SET last_finished_at = NOW(),
           last_status = 'failed',
           last_error = $2
       WHERE job_name = $1`,
      [JOB_NAME, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [DLQ_LOCK_KEY]);
    } catch (unlockErr) {
      log.warn({ err: unlockErr }, "Failed to unlock dead-letter advisory lock");
    }
    client.release();
  }
}
