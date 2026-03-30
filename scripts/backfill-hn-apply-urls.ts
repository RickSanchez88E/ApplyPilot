/**
 * Backfill HN hiring jobs — extract company career URLs from HN comments.
 * 
 * This script:
 * 1. Finds all hn_hiring jobs in DB that have apply_url pointing to
 *    news.ycombinator.com or ycombinator.com/apply/
 * 2. Fetches each HN comment to extract the real company career URL
 * 3. Updates apply_url in jobs_current
 * 4. Resets apply_discovery_results to trigger re-resolution
 */
import { query } from '../src/db/client.js';
import { createChildLogger } from '../src/lib/logger.js';

const log = createChildLogger({ module: 'backfill-hn-urls' });

const ATS_URL_PATTERNS = [
  /greenhouse\.io/i, /boards\.greenhouse/i,
  /lever\.co/i, /jobs\.lever/i,
  /ashbyhq\.com/i, /bamboohr\.com/i,
  /smartrecruiters\.com/i, /workday\.com/i, /myworkdayjobs/i,
  /icims\.com/i, /jobvite\.com/i, /recruitee\.com/i,
  /breezy\.hr/i, /applytojob\.com/i,
  /workable\.com/i,
];

const CAREER_URL_PATTERNS = [
  /\/careers?\b/i, /\/jobs?\b/i, /\/openings?\b/i,
  /\/positions?\b/i, /\/hiring\b/i, /\/apply\b/i,
  /\/vacancies/i, /\/join\b/i, /\/work-with-us/i,
];

const SKIP_DOMAINS = new Set([
  "news.ycombinator.com", "www.ycombinator.com", "ycombinator.com",
  "github.com", "twitter.com", "x.com", "linkedin.com",
  "www.linkedin.com", "en.wikipedia.org",
]);

function extractBestApplyUrl(html: string): string | undefined {
  const hrefRegex = /href="([^"]+)"/gi;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1]!
      .replace(/&amp;/g, "&")
      .replace(/&#x2F;/g, "/")
      .replace(/&#x3D;/g, "=")
      .trim();
    if (url.startsWith("http")) {
      try {
        const parsed = new URL(url);
        if (!SKIP_DOMAINS.has(parsed.hostname)) {
          urls.push(url);
        }
      } catch { /* skip */ }
    }
  }

  if (urls.length === 0) return undefined;

  const scored = urls.map((url) => {
    let score = 10;
    if (ATS_URL_PATTERNS.some((p) => p.test(url))) score += 100;
    if (CAREER_URL_PATTERNS.some((p) => p.test(url))) score += 50;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url;
}

const HN_API = "https://hacker-news.firebaseio.com/v0";

async function main() {
  // Find HN jobs with bad apply_url
  const rows = await query<{
    job_key: string;
    apply_url: string;
    canonical_url: string;
  }>(`
    SELECT job_key, apply_url, canonical_url
    FROM jobs_current
    WHERE source = 'hn_hiring'
      AND (
        apply_url LIKE '%ycombinator.com/apply%'
        OR apply_url LIKE '%news.ycombinator.com/item%'
        OR apply_url IS NULL
      )
  `);

  console.log(`Found ${rows.rows.length} HN jobs needing URL extraction`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows.rows) {
    // Extract HN item ID from canonical_url or apply_url
    const hnUrl = row.canonical_url || row.apply_url;
    const itemMatch = hnUrl?.match(/item\?id=(\d+)/);
    if (!itemMatch) {
      skipped++;
      continue;
    }

    const itemId = itemMatch[1];

    try {
      const res = await fetch(`${HN_API}/item/${itemId}.json`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { text?: string };

      if (!data?.text) {
        skipped++;
        continue;
      }

      const extractedUrl = extractBestApplyUrl(data.text);

      if (!extractedUrl) {
        skipped++;
        continue;
      }

      // Update jobs_current with the real apply URL
      await query(
        `UPDATE jobs_current SET apply_url = $1, updated_at = NOW() WHERE job_key = $2`,
        [extractedUrl, row.job_key],
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
        [extractedUrl, row.job_key],
      );

      updated++;
      if (updated % 20 === 0) {
        console.log(`  Progress: ${updated} updated, ${skipped} skipped`);
      }

      // Rate limit: 50ms between requests
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      failed++;
      log.warn({ jobKey: row.job_key, err: String(err) }, "Failed to fetch HN item");
    }
  }

  console.log(`\nResults:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (no URL found): ${skipped}`);
  console.log(`  Failed: ${failed}`);

  process.exit(0);
}

main();
