/**
 * Dispatch batched resolve_apply jobs for existing jobs_current rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-apply-discovery.ts --limit=120
 *   npx tsx scripts/backfill-apply-discovery.ts --source=jooble --limit=50
 */

import { dispatchApplyDiscoveryBackfill } from "../src/domain/apply-discovery/dispatch.js";
import { closePool } from "../src/db/client.js";
import { closeQueues } from "../src/queue/setup.js";
import { closeRedis } from "../src/lib/redis.js";

function readArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((x) => x.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

async function main(): Promise<void> {
  const source = readArg("source");
  const limitRaw = readArg("limit");
  const limit = limitRaw ? Number(limitRaw) : 100;

  const result = await dispatchApplyDiscoveryBackfill({
    source,
    limit: Number.isFinite(limit) ? limit : 100,
  });

  console.log(
    JSON.stringify(
      {
        source: source ?? "all",
        limit,
        candidates: result.candidates,
        dispatched: result.dispatched,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error("[backfill-apply-discovery] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await closeRedis();
    await closePool();
  });
