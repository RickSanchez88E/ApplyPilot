import pg from "pg";

async function main() {
  const c = new pg.Client({
    connectionString: "postgres://orchestrator:orchestrator@localhost:5433/job_orchestrator",
  });
  await c.connect();
  
  const r1 = await c.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'src_%'");
  console.log("Schemas:", r1.rows.map((r: any) => r.nspname).join(", "));
  
  const r2 = await c.query("SELECT count(*)::int as cnt FROM src_linkedin.jobs");
  console.log("LinkedIn jobs:", r2.rows[0].cnt);
  
  const r3 = await c.query("SELECT count(*)::int as cnt FROM public.jobs_all");
  console.log("Total in view:", r3.rows[0].cnt);

  const r4 = await c.query("SELECT source, count(*)::int as cnt FROM public.jobs_all GROUP BY source");
  console.log("By source:", r4.rows);
  
  await c.end();
}

main();
