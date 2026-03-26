import pg from "pg";
import { getConfig } from "../shared/config.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "db" });

let pool: pg.Pool | null = null;
let poolEnded = false;

export function getPool(): pg.Pool {
  if (pool && !poolEnded) return pool;

  const config = getConfig();

  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  poolEnded = false;

  pool.on("error", (err) => {
    log.error({ err }, "Unexpected pool error");
  });

  pool.on("connect", () => {
    log.debug("New DB connection established");
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    poolEnded = true;
    await pool.end();
    pool = null;
    log.info("DB pool closed");
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  const start = Date.now();
  const result = await p.query<T>(text, values);
  const durationMs = Date.now() - start;

  log.debug({ query: text.slice(0, 80), durationMs, rows: result.rowCount }, "Query executed");
  return result;
}
