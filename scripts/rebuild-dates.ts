/**
 * Database rebuild: delete corrupted data, null out unreliable dates.
 * Then verify final state.
 */
import { query, closePool } from '../src/db/client.js';
import '../src/shared/config.js';
import fs from 'fs';

const out: string[] = [];
function log(s: string) { out.push(s); console.log(s); }

async function main() {
  log('=== DATABASE REBUILD ===');
  log(`Timestamp: ${new Date().toISOString()}\n`);

  // --- 1. Delete ALL HN Hiring (147 records from wrong 2020 thread, all NULL posted_date) ---
  const hnBefore = await query(`SELECT COUNT(*)::int as c FROM src_hn_hiring.jobs`);
  log(`HN Hiring: ${hnBefore.rows[0].c} records before delete`);
  await query(`DELETE FROM content_index WHERE source = 'hn_hiring'`);
  const hnDel = await query(`DELETE FROM src_hn_hiring.jobs RETURNING url_hash`);
  log(`HN Hiring: deleted ${hnDel.rowCount} records + content_index entries`);

  // --- 2. Delete Reed records where posted_date IS NULL (corrupted by DD/MM/YYYY bug) ---
  const reedNullBefore = await query(`SELECT COUNT(*)::int as c FROM src_reed.jobs WHERE posted_date IS NULL`);
  log(`\nReed NULL: ${reedNullBefore.rows[0].c} records`);
  // Get url_hashes for content_index cleanup
  const reedNullHashes = await query(`SELECT content_hash FROM src_reed.jobs WHERE posted_date IS NULL`);
  for (const r of reedNullHashes.rows) {
    await query(`DELETE FROM content_index WHERE content_hash = $1 AND source = 'reed'`, [r.content_hash]);
  }
  const reedDel = await query(`DELETE FROM src_reed.jobs WHERE posted_date IS NULL RETURNING url_hash`);
  log(`Reed: deleted ${reedDel.rowCount} NULL-date records + content_index entries`);
  const reedRemain = await query(
    `SELECT COUNT(*)::int as c, MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM src_reed.jobs`
  );
  log(`Reed: ${reedRemain.rows[0].c} remaining, range: ${reedRemain.rows[0].mn} → ${reedRemain.rows[0].mx}`);

  // --- 3. Null out DevITJobs posted_date (activeFrom = platform import time) ---
  const devitUpd = await query(
    `UPDATE src_devitjobs.jobs SET posted_date = NULL WHERE posted_date IS NOT NULL RETURNING url_hash`
  );
  log(`\nDevITJobs: nulled ${devitUpd.rowCount} posted_date (activeFrom ≠ posting date)`);

  // --- 4. Null out Jooble posted_date (updated = aggregator refresh time) ---
  const joobleUpd = await query(
    `UPDATE src_jooble.jobs SET posted_date = NULL WHERE posted_date IS NOT NULL RETURNING url_hash`
  );
  log(`Jooble: nulled ${joobleUpd.rowCount} posted_date (updated ≠ posting date)`);

  // --- FINAL STATE ---
  log('\n=== FINAL STATE ===');
  const schemas = ['src_linkedin', 'src_reed', 'src_devitjobs', 'src_remoteok', 'src_hn_hiring', 'src_jooble'];
  for (const s of schemas) {
    const st = await query(
      `SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d,
              MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM ${s}.jobs`
    );
    const r = st.rows[0];
    log(`${s.replace('src_','').padEnd(12)} total=${String(r.t).padEnd(4)} dated=${String(r.d).padEnd(4)} null=${String(r.t - r.d).padEnd(4)} ${r.mn || '—'} → ${r.mx || '—'}`);
  }

  log('\n=== TOP 10 by posted_date DESC NULLS LAST ===');
  const top = await query(
    `SELECT source, job_title, posted_date::text as pd FROM jobs_all ORDER BY posted_date DESC NULLS LAST LIMIT 10`
  );
  for (const r of top.rows) log(`  [${r.source}] ${r.pd || 'NULL'} | ${r.job_title}`);

  const total = await query(`SELECT COUNT(*)::int as c FROM jobs_all`);
  log(`\nTotal: ${total.rows[0].c}`);
  log('\n=== DONE — now re-scrape HN and Reed ===');

  fs.writeFileSync('D:/tmp/rebuild-results.txt', out.join('\n'));
  await closePool();
}

main().catch(e => { console.error(e); process.exit(1); });
