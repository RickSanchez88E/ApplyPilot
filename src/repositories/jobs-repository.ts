/**
 * Repository for public.jobs_current — the unified job truth table.
 *
 * All status transitions go through assertTransition before writing.
 */

import { query } from "../db/client.js";
import { assertTransition } from "../domain/job-lifecycle/transitions.js";
import type { JobAvailabilityStatus } from "../domain/job-lifecycle/job-status.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "jobs-repo" });

export interface UpsertJobInput {
  jobKey: string;
  source: string;
  externalJobId?: string;
  canonicalUrl?: string;
  title: string;
  company: string;
  location?: string;
  workMode?: "remote" | "hybrid" | "onsite";
  salaryText?: string;
  postedAt?: Date | null;
  contentHash: string;
  applyUrl?: string;
  atsPlatform?: string;
  jdRaw: string;
  rawPayload?: Record<string, unknown>;
}

export interface UpsertResult {
  isNew: boolean;
  previousHash: string | null;
}

export async function upsertJob(input: UpsertJobInput): Promise<UpsertResult> {
  // CTE captures the old content_hash BEFORE the upsert modifies the row.
  // This is critical: without it, RETURNING would read the already-updated hash,
  // making snapshot detection impossible (shouldSnapshot would always see same hash).
  const result = await query<{ is_new: boolean; prev_hash: string | null }>(
    `WITH old AS (
       SELECT content_hash FROM public.jobs_current WHERE job_key = $1
     )
     INSERT INTO public.jobs_current (
       job_key, source, external_job_id, canonical_url,
       title, company, location, work_mode, salary_text,
       posted_at, content_hash, apply_url, ats_platform, jd_raw,
       raw_last_payload, job_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')
     ON CONFLICT (job_key) DO UPDATE SET
       title        = EXCLUDED.title,
       company      = EXCLUDED.company,
       location     = EXCLUDED.location,
       work_mode    = EXCLUDED.work_mode,
       salary_text  = EXCLUDED.salary_text,
       posted_at    = COALESCE(EXCLUDED.posted_at, jobs_current.posted_at),
       last_seen_at = NOW(),
       content_hash = EXCLUDED.content_hash,
       apply_url    = COALESCE(EXCLUDED.apply_url, jobs_current.apply_url),
       ats_platform = COALESCE(EXCLUDED.ats_platform, jobs_current.ats_platform),
       jd_raw       = CASE
                        WHEN length(EXCLUDED.jd_raw) > length(COALESCE(jobs_current.jd_raw, ''))
                        THEN EXCLUDED.jd_raw ELSE jobs_current.jd_raw
                      END,
       raw_last_payload = EXCLUDED.raw_last_payload,
       job_status       = 'active',
       consecutive_missing_count = 0,
       updated_at       = NOW()
     RETURNING
       (xmax = 0) AS is_new,
       (SELECT content_hash FROM old) AS prev_hash`,
    [
      input.jobKey,
      input.source,
      input.externalJobId ?? null,
      input.canonicalUrl ?? null,
      input.title,
      input.company,
      input.location ?? null,
      input.workMode ?? null,
      input.salaryText ?? null,
      input.postedAt ?? null,
      input.contentHash,
      input.applyUrl ?? null,
      input.atsPlatform ?? null,
      input.jdRaw,
      input.rawPayload ? JSON.stringify(input.rawPayload) : null,
    ],
  );

  const row = result.rows[0];
  if (!row) throw new Error(`upsertJob returned no rows for ${input.jobKey}`);

  return { isNew: row.is_new, previousHash: row.prev_hash ?? null };
}

export interface TransitionResult {
  updated: boolean;
}

export async function transitionStatus(
  jobKey: string,
  from: JobAvailabilityStatus,
  to: JobAvailabilityStatus,
  evidence?: { type: string; summary?: string },
): Promise<TransitionResult> {
  assertTransition(from, to);
  if (from === to) return { updated: true };

  const res = await query(
    `UPDATE public.jobs_current SET
       job_status = $2,
       last_evidence_type = $3,
       last_evidence_at = NOW(),
       updated_at = NOW()
     WHERE job_key = $1 AND job_status = $4`,
    [jobKey, to, evidence?.type ?? null, from],
  );

  const updated = (res.rowCount ?? 0) > 0;
  if (!updated) {
    log.warn({ jobKey, from, to }, "Transition no-op: current status does not match expected 'from'");
  } else {
    log.debug({ jobKey, from, to, evidence: evidence?.type }, "Status transition");
  }
  return { updated };
}

export async function incrementMissingCount(jobKey: string): Promise<number> {
  const res = await query<{ consecutive_missing_count: number }>(
    `UPDATE public.jobs_current SET
       consecutive_missing_count = consecutive_missing_count + 1,
       updated_at = NOW()
     WHERE job_key = $1
     RETURNING consecutive_missing_count`,
    [jobKey],
  );
  return res.rows[0]?.consecutive_missing_count ?? 0;
}

export async function getJobByKey(jobKey: string) {
  const res = await query<{
    job_key: string;
    source: string;
    title: string;
    company: string;
    job_status: JobAvailabilityStatus;
    content_hash: string;
    consecutive_missing_count: number;
    apply_url: string | null;
    canonical_url: string | null;
  }>(
    "SELECT job_key, source, title, company, job_status, content_hash, consecutive_missing_count, apply_url, canonical_url FROM public.jobs_current WHERE job_key = $1",
    [jobKey],
  );
  return res.rows[0] ?? null;
}
