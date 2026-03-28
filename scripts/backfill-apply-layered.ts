/**
 * backfill-apply-layered.ts — 分层 Apply Discovery Backfill
 *
 * Dispatches resolve_apply jobs in controlled batches, per-source,
 * with dedup/cooldown to avoid hammering the same job.
 *
 * Candidate selection priority:
 *   1. Never resolved (no adr row)
 *   2. Previously failed / blocked / intermediate_redirect (retryable)
 *   3. platform_desc_only where apply_url differs from source_desc_url (might reach real ATS)
 *
 * Exclusions:
 *   - Already final_form_reached
 *   - Empty/null apply_url AND canonical_url
 *   - Recently attempted (within cooldown window, default 4h)
 *
 * Layered retry policy:
 *   - Resolvable sources: normal retry
 *   - Login-gated sources: login-related statuses are retried ONLY when login state is marked ready
 *   - Login not ready entries are reported as login_pending_pool (not permanently excluded)
 *
 * Usage:
 *   npx tsx scripts/backfill-apply-layered.ts --source=linkedin --batch=30 --rounds=2
 *   npx tsx scripts/backfill-apply-layered.ts --batch=50                       # all sources
 *   npx tsx scripts/backfill-apply-layered.ts --source=reed --batch=20 --dry-run
 *   npx tsx scripts/backfill-apply-layered.ts --source=jooble --cooldown-hours=2
 */

import { query, closePool } from "../src/db/client.js";
import { dispatch } from "../src/queue/setup.js";
import { closeQueues } from "../src/queue/setup.js";
import { closeRedis } from "../src/lib/redis.js";
import { buildResolveApplyPayload } from "../src/domain/apply-discovery/dispatch.js";
import { getApplyBackfillPolicySnapshot } from "../src/domain/apply-discovery/dispatch.js";

function readArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((x) => x.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

const SOURCES = ["linkedin", "reed", "jooble", "devitjobs", "hn_hiring", "remoteok"];

interface BackfillCandidateRow {
  job_key: string;
  source: string;
  apply_url: string | null;
  source_desc_url: string | null;
  priority: number;
  current_status: string | null;
}

interface RoundResult {
  round: number;
  source: string;
  candidates: number;
  dispatched: number;
  skipped: number;
  loginPending: number;
}

const LOGIN_GATED_STATUSES = new Set([
  "requires_login",
  "requires_registration",
  "oauth_google",
  "oauth_linkedin",
]);

function parseCsvEnv(envKey: string, fallback: string[]): string[] {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const normalized = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function getLoginPolicy(): { loginRequiredSources: Set<string>; loginReadySources: Set<string> } {
  const loginRequiredSources = new Set(
    parseCsvEnv("APPLY_LOGIN_REQUIRED_SOURCES", ["linkedin", "reed", "remoteok"]),
  );
  const loginReadySources = new Set(parseCsvEnv("APPLY_LOGIN_READY_SOURCES", []));
  return { loginRequiredSources, loginReadySources };
}

function canRetryStatus(
  source: string,
  status: string | null,
  policy: { loginRequiredSources: Set<string>; loginReadySources: Set<string> },
): boolean {
  if (!status || !LOGIN_GATED_STATUSES.has(status)) return true;
  if (!policy.loginRequiredSources.has(source)) return true;
  return policy.loginReadySources.has(source);
}

async function getCandidatesForSource(
  source: string,
  batch: number,
  cooldownHours: number,
): Promise<BackfillCandidateRow[]> {
  const cooldownInterval = `${cooldownHours} hours`;

  const sql = `
    WITH candidates AS (
      SELECT
        jc.job_key,
        jc.source,
        COALESCE(NULLIF(jc.apply_url, ''), NULLIF(jc.canonical_url, '')) AS apply_url,
        jc.canonical_url AS source_desc_url,
        adr.apply_discovery_status AS current_status,
        CASE
          -- Priority 1: never resolved
          WHEN adr.job_key IS NULL THEN 1
          -- Priority 2: retryable failures
          WHEN adr.apply_discovery_status IN ('failed', 'blocked', 'intermediate_redirect', 'unresolved') THEN 2
          -- Priority 3: login-gated statuses (dispatch depends on login-ready policy)
          WHEN adr.apply_discovery_status IN ('requires_login', 'requires_registration', 'oauth_google', 'oauth_linkedin') THEN 3
          -- Priority 3: platform_desc_only where URL might lead elsewhere
          WHEN adr.apply_discovery_status = 'platform_desc_only'
            AND COALESCE(NULLIF(jc.apply_url, ''), '') != ''
            AND jc.apply_url IS DISTINCT FROM jc.canonical_url
          THEN 4
          ELSE 99
        END AS priority
      FROM public.jobs_current jc
      LEFT JOIN public.apply_discovery_results adr ON adr.job_key = jc.job_key
      WHERE
        -- Must have a URL to resolve
        COALESCE(NULLIF(jc.apply_url, ''), NULLIF(jc.canonical_url, '')) IS NOT NULL
        -- Source filter
        AND jc.source = $2
        -- Exclude already final
        AND (adr.apply_discovery_status IS DISTINCT FROM 'final_form_reached')
        -- Cooldown: skip recently attempted
        AND (adr.updated_at IS NULL OR adr.updated_at < NOW() - ($3 || ' hours')::interval)
    )
    SELECT *
    FROM candidates
    WHERE priority < 99
    ORDER BY priority ASC, apply_url ASC
    LIMIT $1
  `;

  const res = await query<BackfillCandidateRow>(sql, [batch, source, String(cooldownHours)]);
  return res.rows;
}

async function getStatsSnapshot(source?: string): Promise<{
  total: number; discovered: number; final_form: number;
}> {
  const where = source ? "WHERE jc.source = $1" : "";
  const params = source ? [source] : [];
  const sql = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(adr.job_key)::int AS discovered,
      COUNT(*) FILTER (WHERE adr.apply_discovery_status = 'final_form_reached')::int AS final_form
    FROM public.jobs_current jc
    LEFT JOIN public.apply_discovery_results adr ON adr.job_key = jc.job_key
    ${where}
  `;
  const res = await query<{ total: number; discovered: number; final_form: number }>(sql, params);
  return res.rows[0] ?? { total: 0, discovered: 0, final_form: 0 };
}

async function main(): Promise<void> {
  const sourceArg = readArg("source");
  const batch = Math.min(Math.max(parseInt(readArg("batch") ?? "30", 10), 1), 200);
  const rounds = Math.min(Math.max(parseInt(readArg("rounds") ?? "1", 10), 1), 10);
  const cooldownHours = Math.max(parseFloat(readArg("cooldown-hours") ?? "4"), 0);
  const dryRun = process.argv.includes("--dry-run");

  const sources = sourceArg ? [sourceArg] : SOURCES;
  const policy = getLoginPolicy();
  const policySnapshot = getApplyBackfillPolicySnapshot();

  console.log("═════════════════════════════════════════════════════════");
  console.log("  分层 Apply Discovery Backfill");
  console.log("═════════════════════════════════════════════════════════");
  console.log(`  sources:        ${sources.join(", ")}`);
  console.log(`  batch/source:   ${batch}`);
  console.log(`  rounds:         ${rounds}`);
  console.log(`  cooldown:       ${cooldownHours}h`);
  console.log(`  dry-run:        ${dryRun}`);
  console.log(`  login-required: ${Array.from(policy.loginRequiredSources).sort().join(", ") || "(none)"}`);
  console.log(`  login-ready:    ${Array.from(policy.loginReadySources).sort().join(", ") || "(none)"}`);
  console.log(`  gated-statuses: ${policySnapshot.loginGatedStatuses.join(", ")}`);
  console.log("");

  // Before snapshot
  const beforeGlobal = await getStatsSnapshot();
  const beforePerSource: Record<string, { total: number; discovered: number; final_form: number }> = {};
  for (const s of sources) {
    beforePerSource[s] = await getStatsSnapshot(s);
  }

  console.log("─── Before Snapshot ──────────────────────────────────────");
  console.log(`  Global: total=${beforeGlobal.total} discovered=${beforeGlobal.discovered} final_form=${beforeGlobal.final_form}`);
  for (const s of sources) {
    const b = beforePerSource[s]!;
    console.log(`  ${s.padEnd(12)}: total=${b.total} discovered=${b.discovered} final_form=${b.final_form}`);
  }
  console.log("");

  const allResults: RoundResult[] = [];

  for (let round = 1; round <= rounds; round++) {
    console.log(`─── Round ${round}/${rounds} ──────────────────────────────────────`);

    for (const source of sources) {
      const candidates = await getCandidatesForSource(source, batch, cooldownHours);

      if (candidates.length === 0) {
        console.log(`  ${source}: 0 candidates (skip)`);
        allResults.push({ round, source, candidates: 0, dispatched: 0, skipped: 0, loginPending: 0 });
        continue;
      }

      let dispatched = 0;
      let skipped = 0;
      let loginPending = 0;

      for (const c of candidates) {
        if (!canRetryStatus(c.source, c.current_status, policy)) {
          loginPending++;
          continue;
        }

        const payload = buildResolveApplyPayload({
          jobKey: c.job_key,
          source: c.source,
          applyUrl: c.apply_url,
          sourceDescUrl: c.source_desc_url,
        });
        if (!payload) {
          skipped++;
          continue;
        }

        if (dryRun) {
          dispatched++;
          continue;
        }

        try {
          await dispatch(payload);
          dispatched++;
        } catch (err) {
          skipped++;
        }
      }

      const byPriority = candidates.reduce((acc, c) => {
        acc[c.priority] = (acc[c.priority] ?? 0) + 1;
        return acc;
      }, {} as Record<number, number>);

      console.log(
        `  ${source.padEnd(12)}: ${candidates.length} candidates → ${dispatched} dispatched, ${skipped} skipped, ${loginPending} login-pending ` +
        `[P1:${byPriority[1] ?? 0} P2:${byPriority[2] ?? 0} P3:${byPriority[3] ?? 0}]`,
      );
      allResults.push({ round, source, candidates: candidates.length, dispatched, skipped, loginPending });
    }

    if (round < rounds) {
      console.log(`  ⏳ Waiting 5s before next round...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log("");

  // After snapshot (only available if NOT dry-run and workers have consumed; otherwise show dispatch only)
  if (!dryRun) {
    console.log("─── Dispatch Summary ─────────────────────────────────────");
    const totalDispatched = allResults.reduce((sum, r) => sum + r.dispatched, 0);
    const totalCandidates = allResults.reduce((sum, r) => sum + r.candidates, 0);
    const totalLoginPending = allResults.reduce((sum, r) => sum + r.loginPending, 0);
    console.log(`  Total candidates: ${totalCandidates}`);
    console.log(`  Total dispatched: ${totalDispatched}`);
    console.log(`  Login pending pool: ${totalLoginPending}`);
    console.log("");
    console.log("  NOTE: Dispatched jobs are in the queue. Run workers to process them.");
    console.log("  After workers complete, re-run apply-stats.ts to see updated coverage.");
  } else {
    console.log("─── Dry Run Summary ──────────────────────────────────────");
    const totalDispatched = allResults.reduce((sum, r) => sum + r.dispatched, 0);
    console.log(`  Would dispatch: ${totalDispatched} resolve_apply jobs`);
  }

  console.log("");
  console.log("═════════════════════════════════════════════════════════\n");
}

main()
  .catch((err) => {
    console.error("[backfill-apply-layered] crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await closeRedis();
    await closePool();
  });
