/**
 * diagnose-apply-failures.ts
 *
 * Passive diagnostics for apply discovery failures by source.
 * This script does NOT run exploit traffic. It only inspects existing DB samples
 * and performs lightweight single-request HTTP probes for response/redirect evidence.
 *
 * Usage:
 *   npx tsx scripts/diagnose-apply-failures.ts
 *   npx tsx scripts/diagnose-apply-failures.ts --source=jooble
 *   npx tsx scripts/diagnose-apply-failures.ts --json
 */

import { fetch } from "undici";
import { query, closePool } from "../src/db/client.js";

type TargetStatus = "blocked" | "requires_login" | "platform_desc_only";

interface FailureSample {
  source: string;
  job_key: string;
  apply_discovery_status: TargetStatus;
  initial_apply_url: string | null;
  resolved_apply_url: string | null;
  redirect_chain: Array<{ url: string; status?: number }>;
  last_resolution_error: string | null;
  updated_at: string;
}

interface RootCauseItem {
  category: string;
  evidence: string[];
  action: string;
  expectedBenefit: string;
  count: number;
}

const TARGET_STATUSES: TargetStatus[] = ["blocked", "requires_login", "platform_desc_only"];

const PLATFORM_DOMAINS: Record<string, string[]> = {
  linkedin: ["linkedin.com"],
  reed: ["reed.co.uk"],
  jooble: ["jooble.org", "jooble.com"],
  devitjobs: ["devitjobs.uk"],
  hn_hiring: ["news.ycombinator.com"],
  remoteok: ["remoteok.com"],
};

function readArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((x) => x.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

function safeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function probeUrlFromSample(sample: FailureSample): string | null {
  return sample.resolved_apply_url ?? sample.initial_apply_url ?? null;
}

function inferCause(sample: FailureSample): string {
  const probeUrl = probeUrlFromSample(sample) ?? "";
  const host = safeHost(probeUrl) ?? "";
  const errorText = (sample.last_resolution_error ?? "").toLowerCase();
  const chainText = sample.redirect_chain.map((x) => x.url).join(" ").toLowerCase();
  const platformHosts = PLATFORM_DOMAINS[sample.source] ?? [];
  const isPlatformHost = platformHosts.some((domain) => host.includes(domain));

  if (sample.apply_discovery_status === "requires_login") {
    if (chainText.includes("oauth") || chainText.includes("accounts.google.com")) {
      return "oauth_login_wall";
    }
    return "authwall_login_required";
  }

  if (sample.apply_discovery_status === "platform_desc_only") {
    if (chainText.includes("/away/") || probeUrl.includes("/away/")) {
      return "platform_redirect_not_followed";
    }
    if (isPlatformHost) {
      return "platform_description_loop";
    }
    return "non_form_landing_page";
  }

  if (sample.apply_discovery_status === "blocked") {
    if (errorText.includes("timeout") || errorText.includes("err_")) {
      return "transport_timeout_or_block";
    }
    if (chainText.includes("cloudflare") || chainText.includes("captcha") || chainText.includes("challenge")) {
      return "anti_bot_challenge";
    }
    return "generic_blocked";
  }

  return "unknown";
}

function causeAction(source: string, cause: string): { action: string; benefit: string } {
  if (cause === "authwall_login_required" || cause === "oauth_login_wall") {
    return {
      action: `为 ${source} 提供可刷新登录态，并将 ${source} 加入 APPLY_LOGIN_READY_SOURCES 后重跑 backfill`,
      benefit: "解锁 requires_login/oAuth 状态重试，减少登录墙停滞样本",
    };
  }
  if (cause === "platform_redirect_not_followed" || cause === "platform_description_loop") {
    return {
      action: "增强外链提取与跳转链跟踪（away/meta refresh/js location/可见 apply 链接）",
      benefit: "降低 platform_desc_only 占比，提升 resolved_apply_url 可信度",
    };
  }
  if (cause === "anti_bot_challenge" || cause === "transport_timeout_or_block" || cause === "generic_blocked") {
    return {
      action: `降低 ${source} 并发并加大抖动与 breaker 冷却，优先稳定成功率`,
      benefit: "降低 blocked 激增，提升可持续吞吐",
    };
  }
  return {
    action: "补充样本日志并细分失败分类",
    benefit: "提高定位精度，减少未知失败占比",
  };
}

async function passiveHttpProbe(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        "user-agent": "job-orchestrator-diagnostic/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const location = res.headers.get("location");
    const server = res.headers.get("server");
    const cfRay = res.headers.get("cf-ray");
    return `probe status=${res.status}${location ? ` location=${location}` : ""}${server ? ` server=${server}` : ""}${cfRay ? " cf-ray=present" : ""}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `probe_error=${msg}`;
  }
}

async function fetchSamples(source?: string): Promise<FailureSample[]> {
  const params: unknown[] = [TARGET_STATUSES];
  const filters = ["apply_discovery_status = ANY($1::public.apply_discovery_status[])"];
  if (source) {
    params.push(source);
    filters.push(`source = $${params.length}`);
  }

  const sql = `
    SELECT
      source,
      job_key,
      apply_discovery_status::text AS apply_discovery_status,
      initial_apply_url,
      resolved_apply_url,
      redirect_chain,
      last_resolution_error,
      updated_at::text
    FROM public.apply_discovery_results
    WHERE ${filters.join(" AND ")}
    ORDER BY updated_at DESC
    LIMIT 240
  `;
  const res = await query<FailureSample>(sql, params);
  return res.rows;
}

async function main(): Promise<void> {
  const source = readArg("source");
  const json = process.argv.includes("--json");
  const samples = await fetchSamples(source);

  const bySource = new Map<string, FailureSample[]>();
  for (const sample of samples) {
    const group = bySource.get(sample.source) ?? [];
    group.push(sample);
    bySource.set(sample.source, group);
  }

  const matrix: Record<string, RootCauseItem[]> = {};

  for (const [src, rows] of bySource.entries()) {
    const causeMap = new Map<string, RootCauseItem>();
    for (const row of rows) {
      const cause = inferCause(row);
      const action = causeAction(src, cause);
      const existing = causeMap.get(cause) ?? {
        category: cause,
        evidence: [],
        action: action.action,
        expectedBenefit: action.benefit,
        count: 0,
      };
      existing.count += 1;
      if (existing.evidence.length < 3) {
        const probeUrl = probeUrlFromSample(row);
        const host = safeHost(probeUrl) ?? "(invalid-url)";
        const chainTail = row.redirect_chain.slice(-2).map((x) => `${x.status ?? "?"}:${x.url}`).join(" -> ");
        let probeEvidence = "";
        if (probeUrl && existing.evidence.length < 2) {
          probeEvidence = await passiveHttpProbe(probeUrl);
        }
        existing.evidence.push(
          [
            `job_key=${row.job_key}`,
            `status=${row.apply_discovery_status}`,
            `host=${host}`,
            chainTail ? `chain_tail=${chainTail}` : "",
            row.last_resolution_error ? `error=${row.last_resolution_error}` : "",
            probeEvidence,
          ].filter(Boolean).join(" | "),
        );
      }
      causeMap.set(cause, existing);
    }
    matrix[src] = Array.from(causeMap.values()).sort((a, b) => b.count - a.count);
  }

  if (json) {
    console.log(JSON.stringify({ source: source ?? "all", sampleCount: samples.length, matrix }, null, 2));
    return;
  }

  console.log("=== Apply Failure Root-Cause Matrix (Passive Diagnostics) ===");
  console.log(`source=${source ?? "all"} sampleCount=${samples.length}`);
  for (const [src, causes] of Object.entries(matrix)) {
    console.log(`\n[${src}]`);
    for (const cause of causes) {
      console.log(`- category=${cause.category} count=${cause.count}`);
      console.log(`  action=${cause.action}`);
      console.log(`  expectedBenefit=${cause.expectedBenefit}`);
      for (const evidence of cause.evidence) {
        console.log(`  evidence: ${evidence}`);
      }
    }
  }
}

main()
  .catch((err) => {
    console.error("[diagnose-apply-failures] crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

