/**
 * Multi-source trigger script — fetches from all API-accessible sources.
 * Usage: pnpm trigger:multi
 */
import "dotenv/config";
import { runMultiSourceScrape } from "../src/sources/orchestrator.js";
import { getConfig } from "../src/config.js";
import { closePool } from "../src/db/client.js";

async function main() {
  const config = getConfig();
  console.log("🌐 Starting multi-source scrape...");
  console.log(`   Keywords: ${config.searchKeywords.join(", ")}`);
  console.log(`   Location: ${config.searchLocation}`);

  try {
    const result = await runMultiSourceScrape(
      config.searchKeywords,
      config.searchLocation,
    );

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 Multi-Source Scrape Results:");
    console.log(`   Total fetched:    ${result.totalFetched}`);
    console.log(`   Total inserted:   ${result.totalInserted}`);
    console.log(`   Skipped (dupes):  ${result.totalSkipped}`);
    console.log(`   Cross-platform:   ${result.crossPlatformDupes}`);
    console.log(`   Duration:         ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`\n   🇬🇧 Sponsor sync: ${result.sponsorSync.jobsUpdated} jobs updated`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    for (const [source, stats] of Object.entries(result.bySource)) {
      console.log(`   ${source}: ${stats.fetched} fetched`);
    }
  } catch (err) {
    console.error("❌ Multi-source scrape failed:", err);
  } finally {
    await closePool();
  }
}

main();
