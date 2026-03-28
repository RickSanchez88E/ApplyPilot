/**
 * Multi-source dedup — schema-aware idempotent insert with cross-platform fingerprinting.
 *
 * Two-layer dedup:
 *   1. url_hash: exact URL dedup within source schema (same listing = skip)
 *   2. content_hash: cross-platform linking (same company+title = link in content_index)
 *
 * Each source inserts into its own schema: src_linkedin.jobs, src_reed.jobs, etc.
 * Phase 1 dual-write: also upserts into public.jobs_current for lifecycle tracking.
 */

import { query } from "../db/client.js";
import { createChildLogger } from "../lib/logger.js";
import type { NewJob } from "../shared/types.js";
import { hashUrl, contentHash } from "../lib/utils.js";
import { sourceTable, CONTENT_INDEX_TABLE, JOBS_ALL_VIEW } from "../db/schema-router.js";
import { buildJobKey } from "../domain/dedup/job-key.js";
import { payloadHash } from "../domain/dedup/content-hash.js";
import { shouldSnapshot } from "../domain/dedup/snapshot-policy.js";
import { upsertJob } from "../repositories/jobs-repository.js";
import { insertSnapshot } from "../repositories/snapshot-repository.js";

const log = createChildLogger({ module: "dedup" });

/**
 * Validate a Date value:
 *   - Returns null if the Date is invalid (NaN)
 *   - Returns null if the Date is in the future (> now + 1 day)
 * Prevents Invalid Date / corrupted future timestamps from entering PostgreSQL.
 */
function safeDate(d: Date | undefined | null): Date | null {
  if (!d) return null;
  if (!(d instanceof Date)) return null;
  if (Number.isNaN(d.getTime())) return null;
  // Reject future dates — no job can be posted tomorrow
  if (d.getTime() > Date.now() + 86_400_000) return null;
  return d;
}

export interface DedupResult {
  readonly inserted: number;
  readonly skipped: number;
  readonly crossPlatformDupes: number;
}

export async function dedupAndInsert(jobs: ReadonlyArray<NewJob>): Promise<DedupResult> {
  if (jobs.length === 0) {
    return { inserted: 0, skipped: 0, crossPlatformDupes: 0 };
  }

  let inserted = 0;
  let crossPlatformDupes = 0;

  for (const job of jobs) {
    const primaryUrl = job.sourceUrl || job.linkedinUrl || "";
    const urlHash = hashUrl(primaryUrl);
    const cHash = contentHash(job.companyName, job.jobTitle);

    // Determine the target schema table
    const table = sourceTable(job.source);

    // Check cross-platform: does this content_hash exist in OTHER schemas?
    const existingContent = await query<{ source: string; id: string }>(
      `SELECT source, id::text FROM ${JOBS_ALL_VIEW} WHERE content_hash = $1 AND source != $2 LIMIT 1`,
      [cHash, job.source],
    );
    if (existingContent.rows.length > 0) {
      crossPlatformDupes++;
      log.debug(
        {
          company: job.companyName, title: job.jobTitle,
          existingSource: existingContent.rows[0]!.source, newSource: job.source
        },
        "Cross-platform duplicate detected (keeping both, linked via content_hash)"
      );
    }

    // Sanitize posted date — new Date("invalid") produces Invalid Date
    const postedDate = safeDate(job.postedDate);

    // Insert into source-specific schema table
    const result = await query(
      `INSERT INTO ${table} (
        linkedin_url, url_hash, company_name, job_title, location,
        work_mode, salary_text, posted_date, jd_raw, jd_structured,
        apply_type, apply_url, ats_platform,
        source, source_url, content_hash, state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')
      ON CONFLICT (url_hash) DO UPDATE SET
        apply_url = COALESCE(EXCLUDED.apply_url, ${table}.apply_url),
        jd_raw = CASE WHEN length(EXCLUDED.jd_raw) > length(COALESCE(${table}.jd_raw, '')) THEN EXCLUDED.jd_raw ELSE ${table}.jd_raw END
      RETURNING id, (xmax = 0) AS is_new`,
      [
        job.linkedinUrl ?? null,
        urlHash,
        job.companyName,
        job.jobTitle,
        job.location ?? null,
        job.workMode ?? null,
        job.salaryText ?? null,
        postedDate,
        job.jdRaw,
        job.jdStructured ? JSON.stringify(job.jdStructured) : null,
        job.applyType ?? null,
        job.applyUrl ?? null,
        job.atsPlatform ?? null,
        job.source,
        job.sourceUrl ?? null,
        cHash,
      ],
    );

    if (result.rowCount && result.rowCount > 0) {
      const row = result.rows[0];
      const isNew = row?.is_new === true;
      if (isNew) inserted += 1;

      const insertedId = row?.id;
      if (insertedId) {
        await query(
          `INSERT INTO ${CONTENT_INDEX_TABLE} (content_hash, source, source_job_id, source_url, company_name, job_title)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (content_hash, source) DO UPDATE SET source_job_id = $3, source_url = $4`,
          [cHash, job.source, insertedId, job.sourceUrl ?? primaryUrl, job.companyName, job.jobTitle],
        );
      }

      // Dual-write to jobs_current
      try {
        const jobKey = buildJobKey(job.source, {
          sourceUrl: job.sourceUrl,
          linkedinUrl: job.linkedinUrl,
        });
        const pHash = payloadHash(
          job.companyName,
          job.jobTitle,
          job.jdRaw,
          job.location,
        );
        const upsertResult = await upsertJob({
          jobKey,
          source: job.source,
          canonicalUrl: job.sourceUrl ?? job.linkedinUrl,
          title: job.jobTitle,
          company: job.companyName,
          location: job.location,
          workMode: job.workMode,
          salaryText: job.salaryText,
          postedAt: postedDate,
          contentHash: pHash,
          applyUrl: job.applyUrl,
          atsPlatform: job.atsPlatform,
          jdRaw: job.jdRaw,
        });

        if (!upsertResult.isNew && upsertResult.previousHash && shouldSnapshot(upsertResult.previousHash, pHash)) {
          await insertSnapshot({
            jobKey,
            contentHash: pHash,
            payload: {
              title: job.jobTitle,
              company: job.companyName,
              location: job.location,
              jdRaw: job.jdRaw.slice(0, 2000),
            },
          });
        }
      } catch (err) {
        log.warn({ err, source: job.source, title: job.jobTitle }, "Dual-write to jobs_current failed (non-fatal)");
      }
    }
  }

  const skipped = jobs.length - inserted;

  log.info(
    { total: jobs.length, inserted, skipped, crossPlatformDupes },
    "Dedup insert complete"
  );

  return { inserted, skipped, crossPlatformDupes };
}

export async function getExistingHashes(
  urls: ReadonlyArray<string>,
  source: string = "linkedin",
): Promise<ReadonlySet<string>> {
  if (urls.length === 0) {
    return new Set();
  }

  const hashes = urls.map(hashUrl);
  const table = sourceTable(source);

  const placeholders = hashes.map((_h, i) => `$${i + 1}`).join(", ");
  const result = await query<{ url_hash: string }>(
    `SELECT url_hash FROM ${table} WHERE url_hash IN (${placeholders})`,
    hashes,
  );

  const existingSet = new Set(result.rows.map((row) => row.url_hash));
  log.debug({ checked: urls.length, existing: existingSet.size, source }, "Existing hash check");

  return existingSet;
}
