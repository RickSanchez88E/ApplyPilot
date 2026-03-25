import path from "node:path";
import pg from "pg";
import { migrate } from "postgres-migrations";
import { getConfig } from "../config.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "migrate" });

export async function runMigrations(): Promise<void> {
  const config = getConfig();
  const migrationsDir = path.join(import.meta.dirname, "migrations");

  log.info({ migrationsDir }, "Running database migrations");

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await migrate({ client }, migrationsDir);
  } finally {
    await client.end();
  }

  log.info("Migrations complete");
}

const isDirectRun =
  process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js");
if (isDirectRun) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied successfully");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
