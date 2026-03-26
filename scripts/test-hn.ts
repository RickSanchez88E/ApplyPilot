import '../src/shared/config.js';
import fs from 'fs';

const lines: string[] = [];
function log(s: string) { lines.push(s); console.log(s); }

async function main() {
  log('=== HN HIRING DIRECT TEST ===');

  const url = 'https://hn.algolia.com/api/v1/search_by_date?query=%22Ask+HN%3A+Who+is+hiring%22&tags=story,ask_hn&hitsPerPage=3';
  log(`Query: ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  log(`Hits: ${data.hits?.length || 0}`);
  for (const h of (data.hits || [])) {
    log(`  id=${h.objectID} title="${h.title}" created=${h.created_at}`);
  }

  if (!data.hits?.length) { log('NO HITS'); fs.writeFileSync('D:/tmp/hn-test.txt', lines.join('\n')); return; }

  const tid = data.hits[0].objectID;
  log(`\nThread ${tid} comments:`);
  const tr = await fetch(`https://hacker-news.firebaseio.com/v0/item/${tid}.json`);
  const td = await tr.json();
  log(`Title: ${td.title}`);
  log(`Kids: ${td.kids?.length || 0}`);

  if (td.kids?.length) {
    for (const cid of td.kids.slice(0, 3)) {
      const cr = await fetch(`https://hacker-news.firebaseio.com/v0/item/${cid}.json`);
      const cd = await cr.json();
      const txt = (cd.text || '').replace(/<[^>]+>/g, ' ').slice(0, 80);
      log(`  c=${cid} by=${cd.by} time=${cd.time} date=${new Date((cd.time||0)*1000).toISOString().slice(0,10)} "${txt}"`);
    }
  }

  log('\n=== Adapter run ===');
  const { hnHiringAdapter } = await import('../src/sources/hn-hiring.js');
  const jobs = await hnHiringAdapter.fetchJobs(
    ['software engineer', 'backend engineer', 'security engineer'],
    'London, United Kingdom'
  );
  log(`Jobs: ${jobs.length}`);
  for (const j of jobs.slice(0, 5)) {
    log(`  ${j.postedDate?.toISOString()?.slice(0,10) || 'NULL'} | ${j.jobTitle?.slice(0,40)} @ ${j.companyName?.slice(0,25)}`);
  }

  fs.writeFileSync('D:/tmp/hn-test.txt', lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
