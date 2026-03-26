import '../src/shared/config.js';
import fs from 'fs';

const lines: string[] = [];
function log(s: string) { lines.push(s); console.log(s); }

async function main() {
  log('=== REED ADAPTER TEST ===');
  const { reedAdapter } = await import('../src/sources/reed.js');
  const jobs = await reedAdapter.fetchJobs(
    ['software engineer'],
    'London, United Kingdom',
    { maxAgeDays: 1 }
  );
  log(`Jobs returned: ${jobs.length}`);
  for (const j of jobs.slice(0, 5)) {
    log(`  posted=${j.postedDate?.toISOString()?.slice(0,10) || 'NULL'} | ${j.jobTitle?.slice(0,40)} @ ${j.companyName?.slice(0,25)}`);
  }
  
  // Also test without time filter
  const jobs2 = await reedAdapter.fetchJobs(
    ['software engineer'],
    'London, United Kingdom'
  );
  log(`\nWithout time filter: ${jobs2.length} jobs`);
  for (const j of jobs2.slice(0, 5)) {
    log(`  posted=${j.postedDate?.toISOString()?.slice(0,10) || 'NULL'} | ${j.jobTitle?.slice(0,40)}`);
  }

  fs.writeFileSync('D:/tmp/reed-test.txt', lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
