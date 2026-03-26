import "dotenv/config";
import { query, closePool } from "../src/db/client.js";

async function main(): Promise<void> {
  await query(`
    CREATE OR REPLACE VIEW public.jobs_all AS
      SELECT *, 'linkedin' AS _schema FROM src_linkedin.jobs
      UNION ALL
      SELECT *, 'devitjobs' AS _schema FROM src_devitjobs.jobs
      UNION ALL
      SELECT *, 'reed' AS _schema FROM src_reed.jobs
      UNION ALL
      SELECT *, 'jooble' AS _schema FROM src_jooble.jobs
      UNION ALL
      SELECT *, 'hn_hiring' AS _schema FROM src_hn_hiring.jobs
      UNION ALL
      SELECT *, 'remoteok' AS _schema FROM src_remoteok.jobs
  `);

  const result = await query<{ total: number; jooble_count: number }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE source = 'jooble')::int AS jooble_count
    FROM public.jobs_all
  `);

  console.log(JSON.stringify(result.rows[0] ?? {}, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
