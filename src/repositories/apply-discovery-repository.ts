import { query } from "../db/client.js";
import type { ApplyResolutionResult, RedirectStep, FormSchemaSnapshot } from "../domain/apply-discovery/types.js";

export interface ApplyDiscoveryRecord {
  id: string;
  job_key: string;
  source: string;
  apply_discovery_status: string;
  source_desc_url: string | null;
  initial_apply_url: string | null;
  resolved_apply_url: string | null;
  final_form_url: string | null;
  redirect_chain: RedirectStep[];
  login_required: boolean;
  registration_required: boolean;
  oauth_provider: string | null;
  final_form_reached_at: string | null;
  form_schema_snapshot: FormSchemaSnapshot | null;
  form_provider: string | null;
  last_resolution_error: string | null;
  resolver_version: string;
  updated_at: string;
  created_at: string;
}

export async function upsertApplyDiscovery(
  jobKey: string,
  source: string,
  result: ApplyResolutionResult,
  sourceDescUrl?: string,
  initialApplyUrl?: string,
): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO public.apply_discovery_results
       (job_key, source, apply_discovery_status, source_desc_url, initial_apply_url,
        resolved_apply_url, final_form_url, redirect_chain, login_required,
        registration_required, oauth_provider, final_form_reached_at,
        form_schema_snapshot, form_provider, last_resolution_error, resolver_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '1.0')
     ON CONFLICT (job_key) DO UPDATE SET
       apply_discovery_status = EXCLUDED.apply_discovery_status,
       resolved_apply_url = EXCLUDED.resolved_apply_url,
       final_form_url = EXCLUDED.final_form_url,
       redirect_chain = EXCLUDED.redirect_chain,
       login_required = EXCLUDED.login_required,
       registration_required = EXCLUDED.registration_required,
       oauth_provider = EXCLUDED.oauth_provider,
       final_form_reached_at = EXCLUDED.final_form_reached_at,
       form_schema_snapshot = EXCLUDED.form_schema_snapshot,
       form_provider = EXCLUDED.form_provider,
       last_resolution_error = EXCLUDED.last_resolution_error,
       updated_at = NOW()
     RETURNING id::text`,
    [
      jobKey,
      source,
      result.status,
      sourceDescUrl ?? null,
      initialApplyUrl ?? null,
      result.resolvedUrl ?? null,
      result.finalFormUrl ?? null,
      JSON.stringify(result.redirectChain),
      result.loginRequired,
      result.registrationRequired,
      result.oauthProvider ?? null,
      result.status === "final_form_reached" ? new Date().toISOString() : null,
      result.formSchema ? JSON.stringify(result.formSchema) : null,
      result.formProvider ?? null,
      result.error ?? null,
    ],
  );

  await query(
    `UPDATE public.jobs_current
     SET
       apply_resolution_status = $2::public.apply_discovery_status,
       apply_resolution_updated_at = NOW(),
       apply_resolution_error = $3,
       final_apply_url = CASE
         WHEN $2::public.apply_discovery_status = 'final_form_reached'
           THEN COALESCE($4, $5, final_apply_url)
         ELSE final_apply_url
       END,
       apply_url = CASE
         WHEN $2::public.apply_discovery_status = 'final_form_reached'
           THEN COALESCE($4, $5, apply_url)
         WHEN apply_url IS NULL OR btrim(apply_url) = ''
           THEN COALESCE($5, apply_url)
         ELSE apply_url
       END,
       updated_at = NOW()
     WHERE job_key = $1`,
    [
      jobKey,
      result.status,
      result.error ?? null,
      result.finalFormUrl ?? null,
      result.resolvedUrl ?? null,
    ],
  );

  return res.rows[0]!.id;
}

export async function getApplyDiscoveryByJobKey(jobKey: string): Promise<ApplyDiscoveryRecord | null> {
  const res = await query<ApplyDiscoveryRecord>(
    `SELECT id::text, * FROM public.apply_discovery_results WHERE job_key = $1`,
    [jobKey],
  );
  return res.rows[0] ?? null;
}

export async function getApplyDiscoveryStats(source?: string): Promise<{
  total: number;
  byStatus: Record<string, number>;
  coverage: {
    resolvedJobs: number;
    unresolvedJobs: number;
    totalJobs: number;
    resolvedRate: number;
  };
}> {
  const whereClause = source ? "WHERE source = $1" : "";
  const params = source ? [source] : [];

  const res = await query<{ status: string; count: number }>(
    `SELECT apply_discovery_status AS status, COUNT(*)::int AS count
     FROM public.apply_discovery_results ${whereClause}
     GROUP BY apply_discovery_status
     ORDER BY count DESC`,
    params,
  );

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of res.rows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }

  const coverageRes = await query<{ resolved_jobs: number; unresolved_jobs: number; total_jobs: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE apply_resolution_status IS NOT NULL)::int AS resolved_jobs,
       COUNT(*) FILTER (WHERE apply_resolution_status IS NULL)::int AS unresolved_jobs,
       COUNT(*)::int AS total_jobs
     FROM public.jobs_current ${whereClause}`,
    params,
  );

  const resolvedJobs = coverageRes.rows[0]?.resolved_jobs ?? 0;
  const unresolvedJobs = coverageRes.rows[0]?.unresolved_jobs ?? 0;
  const totalJobs = coverageRes.rows[0]?.total_jobs ?? 0;

  return {
    total,
    byStatus,
    coverage: {
      resolvedJobs,
      unresolvedJobs,
      totalJobs,
      resolvedRate: totalJobs > 0 ? (resolvedJobs / totalJobs) * 100 : 0,
    },
  };
}

export async function getRecentApplyDiscoveries(
  source?: string,
  limit: number = 20,
): Promise<ApplyDiscoveryRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (source) {
    conditions.push(`source = $${idx++}`);
    params.push(source);
  }
  params.push(Math.min(limit, 100));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const res = await query<ApplyDiscoveryRecord>(
    `SELECT id::text, job_key, source, apply_discovery_status, source_desc_url,
            initial_apply_url, resolved_apply_url, final_form_url,
            redirect_chain, login_required, registration_required,
            oauth_provider, final_form_reached_at, form_schema_snapshot,
            form_provider, last_resolution_error, resolver_version,
            updated_at, created_at
     FROM public.apply_discovery_results ${where}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    params,
  );
  return res.rows;
}
