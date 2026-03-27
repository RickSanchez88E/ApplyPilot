/**
 * Dead Letter Queue — expired job cleanup.
 *
 * Checks job URLs for expiry markers (HTTP status, page content).
 * Supports Reed (explicit "expired" status), and generic patterns.
 */
import { query } from "./client.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "dead-letter" });

/** Patterns that indicate a job listing has expired */
const EXPIRED_PATTERNS = [
  /the job has expired/i,
  /this job is no longer available/i,
  /this position has been filled/i,
  /listing has expired/i,
  /no longer accepting applications/i,
  /job not found/i,
  /this vacancy has been closed/i,
];

/** Check a single URL to see if the job is expired (via HTTP HEAD/GET) */
async function isUrlExpired(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    clearTimeout(timeout);

    // Reed returns 410 Gone for expired jobs
    if (resp.status === 410 || resp.status === 404) return true;

    // Check body for expired text
    const body = await resp.text();
    const snippet = body.slice(0, 5000).toLowerCase();
    return EXPIRED_PATTERNS.some((p) => p.test(snippet));
  } catch {
    // Network error — don't mark as expired, could be temporary
    return false;
  }
}

export interface DeadLetterResult {
  checked: number;
  expired: number;
  deleted: number;
  errors: number;
  details: { id: number; title: string; source: string; url: string }[];
}

/**
 * Scan all jobs across all source schemas, check for expiry, delete expired ones.
 *
 * @param batchSize How many jobs to check per run (default 50)
 * @param sources Optional source filter (e.g. ['reed', 'jooble'])
 */
export async function runDeadLetterScan(
  batchSize = 50,
  sources?: string[],
): Promise<DeadLetterResult> {
  const result: DeadLetterResult = { checked: 0, expired: 0, deleted: 0, errors: 0, details: [] };

  // Get all source schemas
  const schemaQuery = sources
    ? `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])`
    : `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'src_%'`;
  const schemaParams = sources ? [sources.map((s) => `src_${s}`)] : [];
  const schemas = await query<{ nspname: string }>(schemaQuery, schemaParams);

  for (const { nspname } of schemas.rows) {
    const sourceName = nspname.replace("src_", "");

    // Get oldest jobs with URLs to check
    const jobs = await query<{ id: number; job_title: string; apply_url: string; source_url: string }>(
      `SELECT id, job_title, COALESCE(apply_url, '') as apply_url, COALESCE(source_url, '') as source_url
       FROM ${nspname}.jobs
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize],
    );

    for (const job of jobs.rows) {
      const url = job.apply_url || job.source_url;
      if (!url || url === "#") continue;

      result.checked++;
      try {
        const expired = await isUrlExpired(url);
        if (expired) {
          result.expired++;
          // Delete expired job
          await query(`DELETE FROM ${nspname}.jobs WHERE id = $1`, [job.id]);
          result.deleted++;
          result.details.push({
            id: job.id,
            title: job.job_title,
            source: sourceName,
            url,
          });
          log.info({ id: job.id, title: job.job_title.slice(0, 40), source: sourceName }, "Deleted expired job");
        }
      } catch (err) {
        result.errors++;
        log.warn({ err, id: job.id }, "Error checking job expiry");
      }

      // Be nice — small delay between checks
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log.info(
    { checked: result.checked, expired: result.expired, deleted: result.deleted },
    "Dead letter scan complete",
  );

  return result;
}
