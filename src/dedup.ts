/**
 * SHA-256 URL dedup — idempotent insert into the jobs table.
 * Uses ON CONFLICT (url_hash) DO NOTHING to skip duplicates.
 */

import { query } from "./db/client.js";
import { createChildLogger } from "./logger.js";
import type { NewJob } from "./types.js";
import { hashUrl } from "./utils.js";

const log = createChildLogger({ module: "dedup" });

export interface DedupResult {
  readonly inserted: number;
  readonly skipped: number;
}

export async function dedupAndInsert(jobs: ReadonlyArray<NewJob>): Promise<DedupResult> {
  if (jobs.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;

  for (const job of jobs) {
    const urlHash = hashUrl(job.linkedinUrl);

    const result = await query(
      `INSERT INTO jobs (
        linkedin_url,
        url_hash,
        company_name,
        job_title,
        location,
        work_mode,
        salary_text,
        posted_date,
        jd_raw,
        jd_structured,
        apply_type,
        apply_url,
        ats_platform,
        state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
      ON CONFLICT (url_hash) DO NOTHING`,
      [
        job.linkedinUrl,
        urlHash,
        job.companyName,
        job.jobTitle,
        job.location ?? null,
        job.workMode ?? null,
        job.salaryText ?? null,
        job.postedDate ?? null,
        job.jdRaw,
        job.jdStructured ? JSON.stringify(job.jdStructured) : null,
        job.applyType ?? null,
        job.applyUrl ?? null,
        job.atsPlatform ?? null,
      ],
    );

    if (result.rowCount && result.rowCount > 0) {
      inserted += 1;
    }
  }

  const skipped = jobs.length - inserted;

  log.info({ total: jobs.length, inserted, skipped }, "Dedup insert complete");

  return { inserted, skipped };
}

export async function getExistingHashes(urls: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
  if (urls.length === 0) {
    return new Set();
  }

  const hashes = urls.map(hashUrl);

  const placeholders = hashes.map((_h, i) => `$${i + 1}`).join(", ");
  const result = await query<{ url_hash: string }>(
    `SELECT url_hash FROM jobs WHERE url_hash IN (${placeholders})`,
    hashes,
  );

  const existingSet = new Set(result.rows.map((row) => row.url_hash));

  log.debug({ checked: urls.length, existing: existingSet.size }, "Existing hash check");

  return existingSet;
}
