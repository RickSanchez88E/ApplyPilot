/**
 * CLI: Manual trigger for scraping batch.
 * Usage: pnpm tsx scripts/trigger.ts [--force]
 */

import { closePool } from "../src/db/client.js";
import { shouldTriggerBatch, startScraper } from "../src/index.js";

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  if (!force) {
    const status = await shouldTriggerBatch();
    console.log(`Trigger check: ${status.trigger ? "YES" : "NO"} — ${status.reason}`);
    if (!status.trigger) {
      console.log("Use --force to override trigger condition.");
      return;
    }
  }

  console.log(`Running scrape batch (force=${force})...`);
  const result = await startScraper({ force });
  console.log("Result:", JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error("Trigger failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
