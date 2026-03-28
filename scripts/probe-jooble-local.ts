import "dotenv/config";
import { scrapeJoobleLocal } from "../src/sources/jooble-local.js";
import { closeBrowser, normalizeKeepAlivePages, getBrowserContext } from "../src/browser/local-browser-manager.js";
import { closePool } from "../src/db/client.js";
import * as fs from "node:fs";

async function main() {
  const t0 = Date.now();
  console.log("=== Jooble Desc Concurrency Experiment ===");
  console.log(`  JOOBLE_DESC_CONCURRENCY  = ${process.env.JOOBLE_DESC_CONCURRENCY ?? "2 (default)"}`);
  console.log(`  JOOBLE_DESC_HARD_CAP     = ${process.env.JOOBLE_DESC_HARD_CAP ?? "5 (default)"}`);
  console.log(`  JOOBLE_PAGE_DELAY_MIN_MS = ${process.env.JOOBLE_PAGE_DELAY_MIN_MS ?? "15000 (default)"}`);
  console.log(`  JOOBLE_PAGE_DELAY_MAX_MS = ${process.env.JOOBLE_PAGE_DELAY_MAX_MS ?? "45000 (default)"}`);
  console.log(`  JOOBLE_MAX_SEARCH_PAGES  = ${process.env.JOOBLE_MAX_SEARCH_PAGES ?? "1 (default)"}`);
  console.log(`  JOOBLE_BREAKER_COOLDOWN_MS = ${process.env.JOOBLE_BREAKER_COOLDOWN_MS ?? "43200000 (default = 12h)"}`);
  console.log(`  CF_THRESHOLD = 1 (hardcoded, single challenge = stop)`);
  console.log("");

  let jobs: any[] = [];
  let error: string | null = null;
  let cfBlocked = false;

  try {
    console.log("[PROBE] Calling scrapeJoobleLocal...");
    jobs = await scrapeJoobleLocal(
      ["software engineer"],
      "London",
    );
    console.log(`[PROBE] scrapeJoobleLocal returned ${jobs.length} jobs`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PROBE] scrapeJoobleLocal threw: ${msg}`);
    error = msg;
    cfBlocked = msg.includes("Cloudflare") || msg.includes("challenge");
  }

  const elapsed = Date.now() - t0;

  // Normalize pages after run
  let pageStatus = { closedCount: 0, remaining: 0 };
  try {
    pageStatus = await normalizeKeepAlivePages();
  } catch (e) {
    console.log("[PROBE] normalizeKeepAlivePages error:", (e as Error).message);
  }

  // Count remaining pages
  const ctx = getBrowserContext();
  const totalPages = ctx ? ctx.pages().length : 0;
  const defaultPages = ctx ? ctx.pages().filter(p => {
    try {
      const url = p.url();
      return url === "about:blank" || url.includes("newtab");
    } catch { return false; }
  }).length : 0;

  console.log("");
  console.log("=== Results ===");
  console.log(`  jobs found               : ${jobs.length}`);
  console.log(`  error                    : ${error ?? "none"}`);
  console.log(`  cf_blocked               : ${cfBlocked}`);
  console.log(`  elapsed_ms               : ${elapsed}`);
  console.log(`  default_pages_closed     : ${pageStatus.closedCount}`);
  console.log(`  default_pages_remaining  : ${pageStatus.remaining}`);
  console.log(`  total_pages_after_run    : ${totalPages}`);
  console.log(`  default_pages_count      : ${defaultPages}`);

  const checks: Record<string, string> = {};

  const descConcurrency = parseInt(process.env.JOOBLE_DESC_CONCURRENCY ?? "2", 10);
  checks["jooble_desc_concurrency_check"] = descConcurrency === 2 ? "PASS (configured=2)" : `FAIL (configured=${descConcurrency})`;
  checks["jooble_default_page_cleanup_check"] = defaultPages <= 1 ? "PASS" : `FAIL (default_pages=${defaultPages})`;

  if (cfBlocked) {
    checks["jooble_challenge_abort_check"] = "PASS (CF detected, run correctly terminated)";
    checks["jooble_real_run_check"] = "PARTIAL_FAIL (CF challenge detected under concurrency=2)";
  } else if (error) {
    checks["jooble_challenge_abort_check"] = "N/A (no challenge occurred)";
    checks["jooble_real_run_check"] = `FAIL (${error})`;
  } else {
    checks["jooble_challenge_abort_check"] = "N/A (no challenge occurred — abort mechanism not triggered)";
    checks["jooble_real_run_check"] = jobs.length > 0
      ? "PASS (concurrency=2, no CF challenge)"
      : "INCONCLUSIVE (no jobs found — search returned empty)";
  }

  console.log("");
  console.log("=== Checks ===");
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${k} = ${v}`);
  }

  // Write JSON result
  const resultPath = "tmp/jooble-probe-result.json";
  fs.mkdirSync("tmp", { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({
    experiment: "jooble_desc_concurrency_2",
    descConcurrency,
    jobsFound: jobs.length,
    error,
    cfBlocked,
    elapsedMs: elapsed,
    totalPagesAfterRun: totalPages,
    defaultPagesAfterRun: defaultPages,
    ...checks,
  }, null, 2));
  console.log(`\nResult written to ${resultPath}`);

  await closeBrowser();
  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
