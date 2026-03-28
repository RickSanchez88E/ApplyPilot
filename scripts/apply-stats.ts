/**
 * apply-stats.ts — 统一验收统计口径 (Single Truth Apply Discovery Stats)
 *
 * Produces a unified matrix of apply discovery coverage across all sources.
 * This is the ONLY source of truth for apply discovery stats.
 * All PROJECT_PROGRESS.md numbers MUST come from this script's output.
 *
 * Acceptance Thresholds (Phase 1):
 *   Global:     discovered / total_jobs >= 30%, final_form / total_jobs >= 10%
 *   Per-source: discovered / source_total >= 20%, final_form / source_total >= 5%
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6380 npx tsx scripts/apply-stats.ts
 *   npx tsx scripts/apply-stats.ts --json   # machine-readable output
 */

import { query, closePool } from "../src/db/client.js";

interface SourceStats {
  source: string;
  total: number;
  discovered: number;
  final_form: number;
  platform_desc_only: number;
  requires_login: number;
  blocked: number;
  failed: number;
  other: number;
  coverage_pct: string;
  final_form_pct: string;
  threshold_discovered_pass: boolean;
  threshold_final_pass: boolean;
}

interface GlobalStats {
  total_jobs: number;
  discovered_total: number;
  final_form_total: number;
  final_form_pct_of_total: string;
  discovered_pct_of_total: string;
  threshold_discovered_pass: boolean;
  threshold_final_pass: boolean;
  by_source: SourceStats[];
  consistency: {
    mismatches: number;
    details: Array<{ job_key: string; jc_status: string; adr_status: string }>;
  };
  by_group: {
    resolvable_sources: GroupStats;
    login_required_sources: GroupStats;
  };
  overall_pass: boolean;
  timestamp: string;
}

interface GroupStats {
  sources: string[];
  total_jobs: number;
  discovered_total: number;
  final_form_total: number;
  discovered_pct: string;
  final_form_pct: string;
}

// Acceptance thresholds
const GLOBAL_DISCOVERED_PCT = 0.30;
const GLOBAL_FINAL_PCT = 0.10;
const SOURCE_DISCOVERED_PCT = 0.20;
const SOURCE_FINAL_PCT = 0.05;
const RESOLVABLE_SOURCES = ["hn_hiring", "devitjobs", "jooble"];
const LOGIN_REQUIRED_SOURCES = ["linkedin", "reed", "remoteok"];

function aggregateGroup(bySource: SourceStats[], sources: string[]): GroupStats {
  const groupRows = bySource.filter((row) => sources.includes(row.source));
  const totalJobs = groupRows.reduce((sum, row) => sum + row.total, 0);
  const discoveredTotal = groupRows.reduce((sum, row) => sum + row.discovered, 0);
  const finalFormTotal = groupRows.reduce((sum, row) => sum + row.final_form, 0);
  const discoveredPct = totalJobs > 0 ? (discoveredTotal / totalJobs) * 100 : 0;
  const finalPct = totalJobs > 0 ? (finalFormTotal / totalJobs) * 100 : 0;
  return {
    sources,
    total_jobs: totalJobs,
    discovered_total: discoveredTotal,
    final_form_total: finalFormTotal,
    discovered_pct: `${discoveredPct.toFixed(1)}%`,
    final_form_pct: `${finalPct.toFixed(1)}%`,
  };
}

async function collectStats(): Promise<GlobalStats> {
  // 1. Total jobs
  const totalRes = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM public.jobs_current`,
  );
  const totalJobs = totalRes.rows[0]?.count ?? 0;

  // 2. Per-source breakdown (single query, single truth)
  const matrixSql = `
    WITH base AS (
      SELECT
        jc.source,
        COUNT(*)::int AS total,
        COUNT(adr.job_key)::int AS discovered,
        COUNT(*) FILTER (WHERE adr.apply_discovery_status = 'final_form_reached')::int AS final_form,
        COUNT(*) FILTER (WHERE adr.apply_discovery_status = 'platform_desc_only')::int AS platform_desc_only,
        COUNT(*) FILTER (WHERE adr.apply_discovery_status IN ('requires_login', 'requires_registration', 'oauth_google', 'oauth_linkedin'))::int AS requires_login,
        COUNT(*) FILTER (WHERE adr.apply_discovery_status = 'blocked')::int AS blocked,
        COUNT(*) FILTER (WHERE adr.apply_discovery_status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE adr.apply_discovery_status IN ('unresolved', 'intermediate_redirect', 'unsupported'))::int AS other
      FROM public.jobs_current jc
      LEFT JOIN public.apply_discovery_results adr ON adr.job_key = jc.job_key
      GROUP BY jc.source
      ORDER BY jc.source
    )
    SELECT * FROM base
  `;
  const matrixRes = await query<{
    source: string;
    total: number;
    discovered: number;
    final_form: number;
    platform_desc_only: number;
    requires_login: number;
    blocked: number;
    failed: number;
    other: number;
  }>(matrixSql);

  let discoveredTotal = 0;
  let finalFormTotal = 0;

  const bySource: SourceStats[] = matrixRes.rows.map((row) => {
    discoveredTotal += row.discovered;
    finalFormTotal += row.final_form;
    const coveragePct = row.total > 0 ? (row.discovered / row.total * 100) : 0;
    const finalPct = row.total > 0 ? (row.final_form / row.total * 100) : 0;
    return {
      source: row.source,
      total: row.total,
      discovered: row.discovered,
      final_form: row.final_form,
      platform_desc_only: row.platform_desc_only,
      requires_login: row.requires_login,
      blocked: row.blocked,
      failed: row.failed,
      other: row.other,
      coverage_pct: coveragePct.toFixed(1) + "%",
      final_form_pct: finalPct.toFixed(1) + "%",
      threshold_discovered_pass: coveragePct >= SOURCE_DISCOVERED_PCT * 100,
      threshold_final_pass: finalPct >= SOURCE_FINAL_PCT * 100,
    };
  });

  // 3. Data consistency check (jobs_current vs apply_discovery_results)
  const consistencyRes = await query<{
    job_key: string;
    jc_status: string;
    adr_status: string;
  }>(`
    SELECT
      jc.job_key,
      jc.apply_resolution_status::text AS jc_status,
      adr.apply_discovery_status::text AS adr_status
    FROM public.jobs_current jc
    INNER JOIN public.apply_discovery_results adr ON adr.job_key = jc.job_key
    WHERE jc.apply_resolution_status IS NOT NULL
      AND jc.apply_resolution_status::text != adr.apply_discovery_status::text
    LIMIT 20
  `);

  const globalDiscoveredPct = totalJobs > 0 ? discoveredTotal / totalJobs : 0;
  const globalFinalPct = totalJobs > 0 ? finalFormTotal / totalJobs : 0;
  const thresholdDiscoveredPass = globalDiscoveredPct >= GLOBAL_DISCOVERED_PCT;
  const thresholdFinalPass = globalFinalPct >= GLOBAL_FINAL_PCT;

  const failedSources = bySource.filter(s => !s.threshold_discovered_pass || !s.threshold_final_pass);
  const overallPass = thresholdDiscoveredPass && thresholdFinalPass && failedSources.length === 0;

  return {
    total_jobs: totalJobs,
    discovered_total: discoveredTotal,
    final_form_total: finalFormTotal,
    discovered_pct_of_total: (globalDiscoveredPct * 100).toFixed(1) + "%",
    final_form_pct_of_total: (globalFinalPct * 100).toFixed(1) + "%",
    threshold_discovered_pass: thresholdDiscoveredPass,
    threshold_final_pass: thresholdFinalPass,
    by_source: bySource,
    consistency: {
      mismatches: consistencyRes.rows.length,
      details: consistencyRes.rows,
    },
    by_group: {
      resolvable_sources: aggregateGroup(bySource, RESOLVABLE_SOURCES),
      login_required_sources: aggregateGroup(bySource, LOGIN_REQUIRED_SOURCES),
    },
    overall_pass: overallPass,
    timestamp: new Date().toISOString(),
  };
}

function printHumanReadable(stats: GlobalStats): void {
  console.log("\n╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║              APPLY DISCOVERY — 统一验收统计 (Single Truth)            ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝");
  console.log(`  Timestamp: ${stats.timestamp}`);
  console.log("");

  console.log("─── Global ───────────────────────────────────────────────");
  console.log(`  total_jobs          = ${stats.total_jobs}`);
  console.log(`  discovered_total    = ${stats.discovered_total}`);
  console.log(`  final_form_total    = ${stats.final_form_total}`);
  console.log(`  discovered_pct      = ${stats.discovered_pct_of_total}  (threshold: ${(GLOBAL_DISCOVERED_PCT * 100).toFixed(0)}%) ${stats.threshold_discovered_pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  final_form_pct      = ${stats.final_form_pct_of_total}  (threshold: ${(GLOBAL_FINAL_PCT * 100).toFixed(0)}%) ${stats.threshold_final_pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("");

  console.log("─── Per-Source Matrix ─────────────────────────────────────");
  const header = [
    "source".padEnd(12),
    "total".padStart(6),
    "disc".padStart(6),
    "final".padStart(6),
    "desc".padStart(6),
    "login".padStart(6),
    "block".padStart(6),
    "fail".padStart(6),
    "other".padStart(6),
    "disc%".padStart(8),
    "final%".padStart(8),
    "result".padStart(8),
  ].join(" ");
  console.log(`  ${header}`);
  console.log("  " + "─".repeat(header.length));

  for (const s of stats.by_source) {
    const pass = s.threshold_discovered_pass && s.threshold_final_pass;
    const row = [
      s.source.padEnd(12),
      String(s.total).padStart(6),
      String(s.discovered).padStart(6),
      String(s.final_form).padStart(6),
      String(s.platform_desc_only).padStart(6),
      String(s.requires_login).padStart(6),
      String(s.blocked).padStart(6),
      String(s.failed).padStart(6),
      String(s.other).padStart(6),
      s.coverage_pct.padStart(8),
      s.final_form_pct.padStart(8),
      (pass ? "PASS" : "FAIL").padStart(8),
    ].join(" ");
    console.log(`  ${row}`);
  }
  console.log("");

  console.log("─── Source Groups (Dual Target System) ─────────────────────");
  console.log(
    `  resolvable (${stats.by_group.resolvable_sources.sources.join(", ")}): total=${stats.by_group.resolvable_sources.total_jobs}, discovered=${stats.by_group.resolvable_sources.discovered_total} (${stats.by_group.resolvable_sources.discovered_pct}), final=${stats.by_group.resolvable_sources.final_form_total} (${stats.by_group.resolvable_sources.final_form_pct})`,
  );
  console.log(
    `  login-required (${stats.by_group.login_required_sources.sources.join(", ")}): total=${stats.by_group.login_required_sources.total_jobs}, discovered=${stats.by_group.login_required_sources.discovered_total} (${stats.by_group.login_required_sources.discovered_pct}), final=${stats.by_group.login_required_sources.final_form_total} (${stats.by_group.login_required_sources.final_form_pct})`,
  );
  console.log("");

  // Consistency
  console.log("─── Data Consistency ─────────────────────────────────────");
  if (stats.consistency.mismatches === 0) {
    console.log("  ✅ jobs_current vs apply_discovery_results: 0 mismatches");
  } else {
    console.log(`  ❌ ${stats.consistency.mismatches} mismatches found:`);
    for (const d of stats.consistency.details.slice(0, 5)) {
      console.log(`     job_key=${d.job_key}  jc=${d.jc_status}  adr=${d.adr_status}`);
    }
    if (stats.consistency.mismatches > 5) {
      console.log(`     ... and ${stats.consistency.mismatches - 5} more`);
    }
  }
  console.log("");

  // Next-step recommendations for failing sources
  const failedSources = stats.by_source.filter(
    s => !s.threshold_discovered_pass || !s.threshold_final_pass,
  );
  if (failedSources.length > 0) {
    console.log("─── 未达标平台 — 下一轮 Backfill 参数 ────────────────────");
    for (const s of failedSources) {
      const neededDisc = Math.max(0, Math.ceil(s.total * SOURCE_DISCOVERED_PCT) - s.discovered);
      const neededFinal = Math.max(0, Math.ceil(s.total * SOURCE_FINAL_PCT) - s.final_form);
      const batch = Math.min(Math.max(neededDisc, 20), 100);
      console.log(`  ${s.source}:`);
      console.log(`    need +${neededDisc} discovered (current: ${s.discovered}/${s.total}, target: ${(SOURCE_DISCOVERED_PCT * 100).toFixed(0)}%)`);
      console.log(`    need +${neededFinal} final_form (current: ${s.final_form}/${s.total}, target: ${(SOURCE_FINAL_PCT * 100).toFixed(0)}%)`);
      console.log(`    recommended: npx tsx scripts/backfill-apply-layered.ts --source=${s.source} --batch=${batch} --rounds=3`);
    }
    console.log("");
  }

  // Overall verdict
  console.log("═══════════════════════════════════════════════════════════");
  if (stats.overall_pass) {
    console.log("  ✅ OVERALL: PASS — 全量最终表单页化 Phase 1 阈值已达标");
  } else {
    console.log("  ❌ OVERALL: FAIL — 未达 Phase 1 阈值");
    if (!stats.threshold_discovered_pass) {
      console.log(`     Global discovered ${stats.discovered_pct_of_total} < ${(GLOBAL_DISCOVERED_PCT * 100).toFixed(0)}%`);
    }
    if (!stats.threshold_final_pass) {
      console.log(`     Global final_form ${stats.final_form_pct_of_total} < ${(GLOBAL_FINAL_PCT * 100).toFixed(0)}%`);
    }
    if (failedSources.length > 0) {
      console.log(`     ${failedSources.length} sources below per-source thresholds: ${failedSources.map(s => s.source).join(", ")}`);
    }
  }
  console.log("═══════════════════════════════════════════════════════════\n");
}

async function main(): Promise<void> {
  const stats = await collectStats();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    printHumanReadable(stats);
  }

  process.exit(stats.overall_pass ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("[apply-stats] crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
