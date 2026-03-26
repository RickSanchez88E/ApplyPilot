import { query, closePool } from '../src/db/client.js';
import '../src/shared/config.js';
import fs from 'fs';

const lines: string[] = [];
function log(s: string) { lines.push(s); console.log(s); }

async function main() {
  log('=== posted_date DATA CLEANUP ===');

  // 1. Reed future dates
  const rf = await query(`SELECT COUNT(*)::int as c FROM src_reed.jobs WHERE posted_date > NOW() + INTERVAL '1 day'`);
  log(`Reed future: ${rf.rows[0].c}`);
  const rc = await query(`UPDATE src_reed.jobs SET posted_date = NULL WHERE posted_date > NOW() + INTERVAL '1 day' RETURNING id`);
  log(`Reed cleaned: ${rc.rowCount}`);
  const rn = await query(`SELECT COUNT(*)::int as c FROM src_reed.jobs WHERE posted_date IS NULL`);
  log(`Reed NULL after: ${rn.rows[0].c}`);
  const rv = await query(`SELECT COUNT(*)::int as c, MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM src_reed.jobs WHERE posted_date IS NOT NULL`);
  log(`Reed valid: ${rv.rows[0].c}, range: ${rv.rows[0].mn} to ${rv.rows[0].mx}`);

  // 2. HN
  const hn = await query(`SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d FROM src_hn_hiring.jobs`);
  log(`HN: ${hn.rows[0].t} total, ${hn.rows[0].d} with date, ${hn.rows[0].t - hn.rows[0].d} NULL`);

  // 3. Jooble
  const jb = await query(`SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d, MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM src_jooble.jobs`);
  log(`Jooble: ${jb.rows[0].t} total, ${jb.rows[0].d} with date, range: ${jb.rows[0].mn} to ${jb.rows[0].mx}`);

  // 4. DevIT
  const dv = await query(`SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d, MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM src_devitjobs.jobs`);
  log(`DevIT: ${dv.rows[0].t} total, ${dv.rows[0].d} with date, range: ${dv.rows[0].mn} to ${dv.rows[0].mx}`);

  // 5. RemoteOK
  const ro = await query(`SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d, MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM src_remoteok.jobs`);
  log(`RemoteOK: ${ro.rows[0].t} total, ${ro.rows[0].d} with date, range: ${ro.rows[0].mn} to ${ro.rows[0].mx}`);

  // 6. LinkedIn
  const li = await query(`SELECT COUNT(*)::int as t, COUNT(posted_date)::int as d, MIN(posted_date)::text as mn, MAX(posted_date)::text as mx FROM src_linkedin.jobs`);
  log(`LinkedIn: ${li.rows[0].t} total, ${li.rows[0].d} with date, range: ${li.rows[0].mn} to ${li.rows[0].mx}`);

  // 7. Top 10
  log('\n=== TOP 10 by posted_date DESC NULLS LAST ===');
  const top = await query(`SELECT source, job_title, company_name, posted_date::text as pd FROM jobs_all ORDER BY posted_date DESC NULLS LAST LIMIT 10`);
  for (const r of top.rows) log(`  [${r.source}] ${r.pd || 'NULL'} | ${r.job_title} @ ${r.company_name}`);

  log('\nDONE');
  fs.writeFileSync('D:/tmp/cleanup.txt', lines.join('\n'));
  log('Saved to D:/tmp/cleanup.txt');
  await closePool();
}
main().catch(e => { console.error(e); process.exit(1); });
