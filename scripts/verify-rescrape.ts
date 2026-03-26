import { query, closePool } from '../src/db/client.js';
import '../src/shared/config.js';
import fs from 'fs';

const out: string[] = [];
function log(s: string) { out.push(s); console.log(s); }

async function main() {
  log('=== POST-RESCRAPE VERIFICATION ===');
  log(`Timestamp: ${new Date().toISOString()}\n`);

  const schemas = ['src_linkedin', 'src_reed', 'src_devitjobs', 'src_remoteok', 'src_hn_hiring', 'src_jooble'];
  for (const s of schemas) {
    const st = await query(
      `SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d,
              MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM ${s}.jobs`
    );
    const r = st.rows[0];
    log(`${s.replace('src_','').padEnd(12)} total=${String(r.t).padEnd(4)} dated=${String(r.d).padEnd(4)} null=${String(r.t - r.d).padEnd(4)} ${r.mn || '—'} → ${r.mx || '—'}`);
  }

  // HN specific check
  log('\n=== HN HIRING SAMPLE ===');
  const hnSample = await query(
    `SELECT job_title, company_name, posted_date::text as pd, source_url FROM src_hn_hiring.jobs ORDER BY posted_date DESC NULLS LAST LIMIT 5`
  );
  if (hnSample.rows.length === 0) {
    log('  (no HN records)');
  } else {
    for (const r of hnSample.rows) log(`  ${r.pd || 'NULL'} | ${r.job_title?.slice(0,40)} @ ${r.company_name?.slice(0,30)}`);
  }

  // Reed specific check — no more future dates?
  log('\n=== REED DATE VALIDATION ===');
  const reedFuture = await query(`SELECT COUNT(*)::int as c FROM src_reed.jobs WHERE posted_date > NOW() + INTERVAL '1 day'`);
  log(`  Future dates: ${reedFuture.rows[0].c}`);
  const reedSample = await query(
    `SELECT job_title, posted_date::text as pd FROM src_reed.jobs WHERE posted_date IS NOT NULL ORDER BY posted_date DESC LIMIT 5`
  );
  for (const r of reedSample.rows) log(`  ${r.pd} | ${r.job_title?.slice(0,50)}`);

  // Top 15 global
  log('\n=== TOP 15 by posted_date DESC NULLS LAST ===');
  const top = await query(
    `SELECT source, job_title, posted_date::text as pd FROM jobs_all ORDER BY posted_date DESC NULLS LAST LIMIT 15`
  );
  for (const r of top.rows) log(`  [${r.source.padEnd(10)}] ${r.pd || 'NULL'.padEnd(25)} | ${r.job_title?.slice(0,50)}`);

  const total = await query(`SELECT COUNT(*)::int as c FROM jobs_all`);
  log(`\nTotal: ${total.rows[0].c}`);

  fs.writeFileSync('D:/tmp/verify-results.txt', out.join('\n'));
  log('\nSaved to D:/tmp/verify-results.txt');
  await closePool();
}

main().catch(e => { console.error(e); process.exit(1); });
