/**
 * Probe: inspect actual API field values for DevITJobs and Jooble
 * to determine real time semantics.
 */
import fs from 'fs';

const out: string[] = [];
function log(s: string) { out.push(s); console.log(s); }

async function main() {
  log('=== DevITJobs API field inspection ===');
  try {
    const res = await fetch('https://devitjobs.uk/api/jobsLight', {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      log(`Total jobs from API: ${data.length}`);
      // Show ALL date-like fields from first 3 items
      for (let i = 0; i < Math.min(3, data.length); i++) {
        const item = data[i];
        log(`\n--- DevIT job ${i+1}: "${item.name}" ---`);
        log(`  activeFrom: ${item.activeFrom}`);
        log(`  activeTo: ${item.activeTo}`);
        log(`  createdAt: ${item.createdAt}`);
        log(`  updatedAt: ${item.updatedAt}`);
        log(`  publishedAt: ${item.publishedAt}`);
        log(`  postedAt: ${item.postedAt}`);
        log(`  date: ${item.date}`);
        // Dump all keys that contain 'date', 'time', 'created', 'active', 'publish', 'posted'
        const timeKeys = Object.keys(item).filter(k => 
          /date|time|creat|activ|publish|post|updat|from|to/i.test(k)
        );
        log(`  All time-related keys: ${JSON.stringify(timeKeys)}`);
        for (const k of timeKeys) {
          log(`    ${k} = ${JSON.stringify(item[k])}`);
        }
      }
    }
  } catch (e) {
    log(`DevIT fetch error: ${e}`);
  }

  log('\n\n=== Jooble API field inspection ===');
  const joobleKey = 'e2511f08-a574-4b5a-a37a-3997d122ba44';
  try {
    const res = await fetch(`https://jooble.org/api/${joobleKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: 'software engineer', location: 'London', page: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    const jobs = data.jobs || [];
    log(`Total jobs from API: ${jobs.length}`);
    for (let i = 0; i < Math.min(3, jobs.length); i++) {
      const item = jobs[i];
      log(`\n--- Jooble job ${i+1}: "${item.title}" ---`);
      // Dump ALL keys
      log(`  All keys: ${JSON.stringify(Object.keys(item))}`);
      const timeKeys = Object.keys(item).filter(k => 
        /date|time|creat|activ|publish|post|updat|from|to/i.test(k)
      );
      log(`  Time-related keys: ${JSON.stringify(timeKeys)}`);
      for (const k of timeKeys) {
        log(`    ${k} = ${JSON.stringify(item[k])}`);
      }
    }
  } catch (e) {
    log(`Jooble fetch error: ${e}`);
  }

  fs.writeFileSync('D:/tmp/api-probe.txt', out.join('\n'));
  log('\nSaved to D:/tmp/api-probe.txt');
}

main().catch(e => { console.error(e); process.exit(1); });
