import { query } from "../../db/client.js";
import { createChildLogger } from "../../lib/logger.js";
import { dispatch } from "../../queue/setup.js";
import type { ResolveApplyPayload } from "../../queue/commands.js";

const log = createChildLogger({ module: "apply-discovery-dispatch" });

interface ResolveApplyCandidateRow {
  job_key: string;
  source: string;
  apply_url: string | null;
  source_desc_url: string | null;
  current_status: string | null;
}

export interface DispatchBackfillOptions {
  source?: string;
  limit?: number;
  cooldownHours?: number;
  loginReadySources?: string[];
}

export interface DispatchBackfillResult {
  candidates: number;
  dispatched: number;
  loginPending: number;
  commands: Array<{ jobKey: string; source: string; jobId: string }>;
}

const LOGIN_GATED_STATUSES = new Set([
  "requires_login",
  "requires_registration",
  "oauth_google",
  "oauth_linkedin",
]);

const DEFAULT_LOGIN_REQUIRED_SOURCES = ["linkedin", "reed", "remoteok"];

function parseCsvEnv(envKey: string, fallback: string[]): string[] {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const normalized = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function getLoginPolicy(overrideReadySources?: string[]): {
  loginRequiredSources: Set<string>;
  loginReadySources: Set<string>;
} {
  const loginRequiredSources = new Set(
    parseCsvEnv("APPLY_LOGIN_REQUIRED_SOURCES", DEFAULT_LOGIN_REQUIRED_SOURCES),
  );
  const loginReadySources = new Set(
    overrideReadySources ?? parseCsvEnv("APPLY_LOGIN_READY_SOURCES", []),
  );
  return { loginRequiredSources, loginReadySources };
}

function canRetryLoginGatedStatus(
  source: string,
  status: string | null,
  policy: { loginRequiredSources: Set<string>; loginReadySources: Set<string> },
): boolean {
  if (!status || !LOGIN_GATED_STATUSES.has(status)) return true;
  if (!policy.loginRequiredSources.has(source)) return true;
  return policy.loginReadySources.has(source);
}

export function getApplyBackfillPolicySnapshot(): {
  loginGatedStatuses: string[];
  loginRequiredSources: string[];
  loginReadySources: string[];
} {
  const policy = getLoginPolicy();
  return {
    loginGatedStatuses: Array.from(LOGIN_GATED_STATUSES.values()),
    loginRequiredSources: Array.from(policy.loginRequiredSources.values()).sort(),
    loginReadySources: Array.from(policy.loginReadySources.values()).sort(),
  };
}

function normalizeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const normalized = url.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildResolveApplyPayload(input: {
  jobKey: string;
  source: string;
  applyUrl?: string | null;
  sourceDescUrl?: string | null;
}): ResolveApplyPayload | null {
  const applyUrl = normalizeUrl(input.applyUrl) ?? normalizeUrl(input.sourceDescUrl);
  if (!applyUrl) return null;

  return {
    type: "resolve_apply",
    jobKey: input.jobKey,
    source: input.source,
    applyUrl,
    sourceDescUrl: normalizeUrl(input.sourceDescUrl),
  };
}

export async function enqueueResolveApplyForJob(input: {
  jobKey: string;
  source: string;
  applyUrl?: string | null;
  sourceDescUrl?: string | null;
}): Promise<string | null> {
  const payload = buildResolveApplyPayload(input);
  if (!payload) return null;
  const jobId = await dispatch(payload);
  return jobId;
}

export async function dispatchApplyDiscoveryBackfill(
  options: DispatchBackfillOptions = {},
): Promise<DispatchBackfillResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const cooldownHours = Math.max(options.cooldownHours ?? 4, 0);
  const policy = getLoginPolicy(options.loginReadySources);
  const params: unknown[] = [limit, String(cooldownHours)];
  const filters: string[] = [
    // Must have a URL to resolve
    "COALESCE(NULLIF(jc.apply_url, ''), NULLIF(jc.canonical_url, '')) IS NOT NULL",
    // Candidate: never resolved, or retryable status, or stale
    `(adr.job_key IS NULL
      OR adr.apply_discovery_status IN ('unresolved', 'failed', 'blocked', 'intermediate_redirect',
        'requires_login', 'requires_registration', 'oauth_google', 'oauth_linkedin', 'platform_desc_only'))`,
    // Exclude already final
    "(adr.apply_discovery_status IS DISTINCT FROM 'final_form_reached')",
    // Cooldown: skip if attempted within last 4 hours
    "(adr.updated_at IS NULL OR adr.updated_at < NOW() - ($2 || ' hours')::interval)",
  ];

  if (options.source) {
    params.push(options.source);
    filters.push(`jc.source = $${params.length}`);
  }

  const sql = `SELECT
      jc.job_key,
      jc.source,
      COALESCE(NULLIF(jc.apply_url, ''), NULLIF(jc.canonical_url, '')) AS apply_url,
      jc.canonical_url AS source_desc_url,
      adr.apply_discovery_status::text AS current_status
    FROM public.jobs_current jc
    LEFT JOIN public.apply_discovery_results adr ON adr.job_key = jc.job_key
    WHERE ${filters.join(" AND ")}
    ORDER BY
      CASE
        WHEN adr.job_key IS NULL THEN 0          -- never resolved (highest priority)
        WHEN adr.apply_discovery_status IN ('failed', 'blocked') THEN 1
        WHEN adr.apply_discovery_status IN ('unresolved', 'intermediate_redirect') THEN 2
        WHEN adr.apply_discovery_status IN ('requires_login', 'requires_registration', 'oauth_google', 'oauth_linkedin') THEN 3
        WHEN adr.apply_discovery_status = 'platform_desc_only' THEN 4
        ELSE 5
      END ASC,
      COALESCE(adr.updated_at, to_timestamp(0)) ASC,
      jc.updated_at DESC
    LIMIT $1`;

  const rows = await query<ResolveApplyCandidateRow>(sql, params);
  const commands: Array<{ jobKey: string; source: string; jobId: string }> = [];
  let loginPending = 0;

  for (const row of rows.rows) {
    if (!canRetryLoginGatedStatus(row.source, row.current_status, policy)) {
      loginPending++;
      continue;
    }

    const payload = buildResolveApplyPayload({
      jobKey: row.job_key,
      source: row.source,
      applyUrl: row.apply_url,
      sourceDescUrl: row.source_desc_url,
    });
    if (!payload) continue;

    try {
      const jobId = await dispatch(payload);
      commands.push({ jobKey: row.job_key, source: row.source, jobId });
    } catch (err) {
      log.warn(
        {
          jobKey: row.job_key,
          source: row.source,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to dispatch apply discovery backfill item",
      );
    }
  }

  return {
    candidates: rows.rows.length,
    dispatched: commands.length,
    loginPending,
    commands,
  };
}
