import { query, closePool } from '../src/db/client.js';
import '../src/shared/config.js';

async function main() {
  await query(`DELETE FROM content_index WHERE source = 'reed'`);
  const r = await query(`DELETE FROM src_reed.jobs RETURNING url_hash`);
  console.log(`Reed: deleted ${r.rowCount} records`);
  await closePool();
}
main().catch(e => { console.error(e); process.exit(1); });
