/**
 * Database reset script — drops all tables and re-runs migrations.
 * Usage: pnpm db:reset
 */

import { query, closePool } from "../src/db/client.js";

async function resetDatabase(): Promise<void> {
  console.log("🗑️  Starting database reset...");

  try {
    // Drop all tables in the correct order
    await query("DROP TABLE IF EXISTS jobs CASCADE");
    console.log("  ✓ Dropped table: jobs");

    // Drop custom types
    await query("DROP TYPE IF EXISTS job_state CASCADE");
    console.log("  ✓ Dropped type: job_state");

    // Drop migrations tracking table (used by postgres-migrations)
    await query("DROP TABLE IF EXISTS migrations CASCADE");
    console.log("  ✓ Dropped table: migrations");

    console.log("\n✅ Database is clean. Run 'pnpm migrate' to recreate the schema.");
  } catch (err) {
    console.error("❌ Database reset failed:", err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

resetDatabase();
