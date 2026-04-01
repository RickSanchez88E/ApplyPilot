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
  /the job position is no longer available/i,
  /job position is no longer available/i,
  /this position has been filled/i,
  /listing has expired/i,
  /no longer accepting applications/i,
  /job not found/i,
  /this vacancy has been closed/i,
  /position is no longer available/i,
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

/**
 * Jooble: "no longer available" appears on Jooble `/desc/` HTML, not on the employer careers URL.
 * Other sources: single URL (prefer apply, else source).
 */
async function isExpiredForRow(
  sourceName: string,
  applyUrl: string,
  sourceUrl: string,
): Promise<boolean> {
  const apply = applyUrl?.trim() || "";
  const src = sourceUrl?.trim() || "";

  if (sourceName === "jooble") {
    const ordered: string[] = [];
    if (src) ordered.push(src);
    if (apply && apply !== src) ordered.push(apply);
    for (const u of ordered) {
      if (u && u !== "#" && (await isUrlExpired(u))) return true;
    }
    return false;
  }

  const primary = apply || src;
  if (!primary || primary === "#") return false;
  return isUrlExpired(primary);
}

export interface DeadLetterResult {
  checked: number;
  expired: number;
  deleted: number;
  jobsCurrentDeleted: number;
  archived: number;
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
  const result: DeadLetterResult = {
    checked: 0,
    expired: 0,
    deleted: 0,
    jobsCurrentDeleted: 0,
    archived: 0,
    errors: 0,
    details: [],
  };

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
      if ((!job.apply_url && !job.source_url) || (job.apply_url === "#" && job.source_url === "#")) {
        continue;
      }

      result.checked++;
      try {
        const expired = await isExpiredForRow(sourceName, job.apply_url, job.source_url);
        if (expired) {
          result.expired++;
          await query(`DELETE FROM ${nspname}.jobs WHERE id = $1`, [job.id]);
          result.deleted++;

          const candidateUrls = [job.apply_url, job.source_url]
            .map((u) => u?.trim() ?? "")
            .filter((u) => u.length > 0 && u !== "#");

          if (candidateUrls.length > 0) {
            const cleanup = await query(
              `DELETE FROM public.jobs_current
               WHERE source = $1
                 AND (
                   canonical_url = ANY($2::text[])
                   OR apply_url = ANY($2::text[])
                 )`,
              [sourceName, candidateUrls],
            );
            result.jobsCurrentDeleted += cleanup.rowCount ?? 0;
          }

          const url = sourceName === "jooble" ? job.source_url || job.apply_url : job.apply_url || job.source_url;

          await query(
            `INSERT INTO public.dead_letter_records (
               source, source_schema, source_job_id, title, url, reason, payload
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [
              sourceName,
              nspname,
              job.id,
              job.job_title,
              url,
              "expired_detected",
              JSON.stringify({ applyUrl: job.apply_url, sourceUrl: job.source_url }),
            ],
          );
          result.archived++;
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

      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log.info(
    {
      checked: result.checked,
      expired: result.expired,
      deleted: result.deleted,
      jobsCurrentDeleted: result.jobsCurrentDeleted,
      archived: result.archived,
    },
    "Dead letter scan complete",
  );

  return result;
}

export async function purgeDeadLetterRecords(): Promise<number> {
  const res = await query(
    `DELETE FROM public.dead_letter_records
     WHERE purge_after <= NOW()`,
  );
  return res.rowCount ?? 0;
}
