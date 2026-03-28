import { query, closePool } from "../src/db/client.js";

async function main(): Promise<void> {
  const sql = `
    SELECT COUNT(*)::int AS mismatches
    FROM public.jobs_current jc
    INNER JOIN public.apply_discovery_results adr ON adr.job_key = jc.job_key
    WHERE jc.apply_resolution_status IS NOT NULL
      AND jc.apply_resolution_status::text <> adr.apply_discovery_status::text
  `;
  const res = await query<{ mismatches: number }>(sql);
  console.log(
    JSON.stringify(
      {
        sql: sql.trim(),
        result: res.rows[0] ?? { mismatches: -1 },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error("[check-apply-consistency] crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

