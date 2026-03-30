/**
 * Backfill Reed jobs — fetch externalUrl from Reed details API.
 *
 * This script:
 * 1. Finds all reed jobs in DB that have apply_url pointing to reed.co.uk
 * 2. Calls the Reed details API to get externalUrl
 * 3. Updates apply_url in jobs_current with the external URL
 * 4. Resets apply_discovery_results to trigger re-resolution
 */
import { query } from '../src/db/client.js';
import { createChildLogger } from '../src/lib/logger.js';

const log = createChildLogger({ module: 'backfill-reed-urls' });

const REED_API_KEY = process.env.REED_API_KEY;
if (!REED_API_KEY) {
  console.error('REED_API_KEY not set');
  process.exit(1);
}

const auth = Buffer.from(`${REED_API_KEY}:`).toString('base64');
const DETAILS_URL = 'https://www.reed.co.uk/api/1.0/jobs';

async function fetchJobDetails(jobId: string): Promise<{ externalUrl?: string; jobDescription?: string } | null> {
  try {
    const res = await fetch(`${DETAILS_URL}/${jobId}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { externalUrl?: string; jobDescription?: string };
  } catch {
    return null;
  }
}

async function main() {
  // Find Reed jobs — extract jobId from reed.co.uk URL
  const rows = await query<{
    job_key: string;
    apply_url: string;
    canonical_url: string;
  }>(`
    SELECT job_key, apply_url, COALESCE(canonical_url, apply_url) as canonical_url
    FROM jobs_current
    WHERE source = 'reed'
      AND (apply_url LIKE '%reed.co.uk%' OR canonical_url LIKE '%reed.co.uk%')
  `);

  console.log(`Found ${rows.rows.length} Reed jobs to check for externalUrl`);

  let updated = 0;
  let noExternal = 0;
  let failed = 0;
  let alreadyExternal = 0;

  for (let i = 0; i < rows.rows.length; i++) {
    const row = rows.rows[i]!;
    
    // Skip if apply_url already points to a non-reed domain
    if (row.apply_url && !row.apply_url.includes('reed.co.uk') && !row.apply_url.includes('reed.com')) {
      alreadyExternal++;
      continue;
    }

    // Extract Reed job ID from URL  
    const url = row.apply_url || row.canonical_url;
    const match = url?.match(/\/(\d+)(?:\?|$|#)/);
    if (!match) {
      failed++;
      continue;
    }

    const jobId = match[1]!;

    try {
      const detail = await fetchJobDetails(jobId);
      
      if (!detail?.externalUrl) {
        noExternal++;
        continue;
      }

      // Update jobs_current with external URL
      await query(
        `UPDATE jobs_current SET apply_url = $1, updated_at = NOW() WHERE job_key = $2`,
        [detail.externalUrl, row.job_key],
      );

      // Reset apply_discovery_results to trigger re-resolution
      await query(
        `UPDATE apply_discovery_results 
         SET apply_discovery_status = 'unresolved',
             resolved_apply_url = NULL,
             final_form_url = NULL,
             form_schema_snapshot = NULL,
             form_provider = NULL,
             login_required = false,
             registration_required = false,
             oauth_provider = NULL,
             initial_apply_url = $1,
             updated_at = NOW() - interval '5 hours'
         WHERE job_key = $2`,
        [detail.externalUrl, row.job_key],
      );

      updated++;

      if (updated % 20 === 0) {
        console.log(`  Progress: ${updated} updated, ${noExternal} no external, ${i + 1}/${rows.rows.length} processed`);
      }

      // Rate limit: ~10 req/s to stay under 2000/hour
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      failed++;
      log.warn({ jobKey: row.job_key, err: String(err) }, "Failed to fetch Reed details");
    }
  }

  console.log(`\nResults:`);
  console.log(`  Updated with externalUrl: ${updated}`);
  console.log(`  Already external: ${alreadyExternal}`);
  console.log(`  No externalUrl available: ${noExternal}`);
  console.log(`  Failed: ${failed}`);

  process.exit(0);
}

main();
