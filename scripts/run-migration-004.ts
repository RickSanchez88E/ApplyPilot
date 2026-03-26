import pg from "pg";
import { readFileSync } from "fs";

async function main() {
  const sql = readFileSync("./src/db/migrations/004_schema_separation.sql", "utf-8");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5433/job_orchestrator",
  });
  await client.connect();
  try {
    await client.query(sql);
    console.log("Migration 004 applied successfully");
  } catch (e: any) {
    console.error("Migration error:", e.message);
  } finally {
    await client.end();
  }
}

main();
