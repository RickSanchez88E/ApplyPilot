import { query } from "./db/client.js";
import { getAdapterCapabilities } from "./sources/orchestrator.js";
import { getConfig, TIME_FILTER_PRESETS } from "./shared/config.js";
import { getScraperConfig, setScraperKeywords, setScraperLocation } from "./db/config-db.js";
import { dispatch } from "./queue/setup.js";
import { routeCommand } from "./queue/commands.js";
import { sourceTable, JOBS_ALL_VIEW, ALL_SOURCE_NAMES, CONTENT_INDEX_TABLE } from "./db/schema-router.js";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChildLogger } from "./lib/logger.js";
import { getProgress, onProgress, offProgress, type ProgressState } from "./lib/progress.js";
import { releaseLease, isLeaseHeld } from "./scheduler/source-lease.js";
import { getBreakerState, forceResetBreaker, isSourceInCooldown } from "./browser/circuit-breaker.js";
import { getApplyDiscoveryStats, getRecentApplyDiscoveries } from "./repositories/apply-discovery-repository.js";
import { dispatchApplyDiscoveryBackfill } from "./domain/apply-discovery/dispatch.js";
import { runDeadLetterMaintenance } from "./domain/dead-letter/maintenance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createChildLogger({ module: "api-server" });
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const serverStartedAt = Date.now();
const DEAD_LETTER_SCAN_INTERVAL_MS =
  parseInt(process.env.DEAD_LETTER_SCAN_INTERVAL_MS ?? String(6 * 60 * 60 * 1000), 10);
const DEAD_LETTER_SCAN_BATCH_SIZE =
  parseInt(process.env.DEAD_LETTER_SCAN_BATCH_SIZE ?? "200", 10);
const DEAD_LETTER_MAINTENANCE_POLL_MS =
  parseInt(process.env.DEAD_LETTER_MAINTENANCE_POLL_MS ?? "30000", 10);

// ── Status ────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    mode: "queue",
    progress: getProgress(),
  });
});

// ── Health ─────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  const startMs = Date.now();
  try {
    await query("SELECT 1");
    const dbLatencyMs = Date.now() - startMs;
    const mem = process.memoryUsage();
    res.json({
      status: "healthy",
      uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
      dbLatencyMs,
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
        rssMB: Math.round(mem.rss / 1048576),
      },
      mode: "queue",
    });
  } catch (err) {
    res.status(503).json({
      status: "unhealthy",
      error: err instanceof Error ? err.message : String(err),
      uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
    });
  }
});

// ── Sources API (includes adapter capabilities for UI) ─────
app.get("/api/sources", (_req, res) => {
  const config = getConfig();
  const caps = getAdapterCapabilities();

  // All possible scrape time options with their minimum granularity requirements (hours)
  const ALL_TIME_OPTIONS = [
    { value: 'r86400',   label: '24h',     minHours: 24 },
    { value: 'r604800',  label: '1 week',  minHours: 24 },
    { value: 'r2592000', label: '1 month', minHours: 24 },
  ];

  const sources = ALL_SOURCE_NAMES.map(name => {
    const cap = caps.find(c => c.name === name);
    const supportsTime = cap?.supportsNativeTimeFilter ?? false;
    const minGranularity = cap?.minTimeGranularityHours ?? null;

    // Compute supported time options: only options whose granularity >= source minimum
    const supportedTimeOptions: string[] = supportsTime && minGranularity !== null
      ? ALL_TIME_OPTIONS
          .filter(opt => opt.minHours >= minGranularity)
          .map(opt => opt.value)
      : [];

    return {
      name,
      enabled: config.enabledSources.includes(name),
      schema: `src_${name}`,
      supportsNativeTimeFilter: supportsTime,
      minTimeGranularityHours: minGranularity,
      displayName: cap?.displayName ?? name,
      // REV-2: Frontend consumes this directly — no guessing
      supportedTimeOptions,
    };
  });
  res.json({ sources, timeFilters: TIME_FILTER_PRESETS });
});

// ── Config: Keywords & Location (DB-backed, persistent) ─────
app.get("/api/config/keywords", async (_req, res) => {
  try {
    const cfg = await getScraperConfig();
    res.json({ keywords: cfg.keywords, location: cfg.location });
  } catch (err) {
    log.error({ err }, "Failed to get config");
    res.status(500).json({ error: "Failed to get config" });
  }
});

app.put("/api/config/keywords", async (req, res) => {
  const { keywords, location } = req.body;

  try {
    if (keywords !== undefined) {
      if (!Array.isArray(keywords) || keywords.some((k: unknown) => typeof k !== "string" || !k)) {
        return res.status(400).json({ error: "keywords must be a non-empty array of strings" });
      }
      await setScraperKeywords(keywords);
    }

    if (location !== undefined) {
      if (typeof location !== "string" || !location) {
        return res.status(400).json({ error: "location must be a non-empty string" });
      }
      await setScraperLocation(location);
    }

    const cfg = await getScraperConfig();
    res.json({
      keywords: cfg.keywords,
      location: cfg.location,
      message: "Config saved to database",
    });
  } catch (err) {
    log.error({ err }, "Failed to save config");
    res.status(500).json({ error: "Failed to save config" });
  }
});

// ── Expiry Recheck (replaces old dead-letter DELETE path) ─────
app.post("/api/jobs/recheck-expiry", async (req, res) => {
  const batchSize = Math.min(Number(req.body?.batchSize) || 50, 200);
  const sources = req.body?.sources as string[] | undefined;

  try {
    const sourceFilter = sources && sources.length > 0
      ? `AND source = ANY($2::text[])`
      : "";
    const params: unknown[] = [batchSize];
    if (sources && sources.length > 0) params.push(sources);

    const candidates = await query<{ job_key: string; source: string }>(
      `SELECT job_key, source FROM public.jobs_current
       WHERE (
         job_status = 'suspected_expired'
         OR (job_status = 'active' AND last_seen_at < NOW() - INTERVAL '48 hours')
         OR (job_status = 'blocked' AND last_evidence_at < NOW() - INTERVAL '6 hours')
       ) ${sourceFilter}
       ORDER BY last_seen_at ASC NULLS FIRST
       LIMIT $1`,
      params,
    );

    const dispatched: { jobKey: string; source: string; queue: string; jobId: string }[] = [];
    for (const row of candidates.rows) {
      const payload = { type: "recheck_expiry" as const, jobKey: row.job_key, source: row.source };
      const queue = routeCommand(payload);
      const jobId = await dispatch(payload);
      dispatched.push({ jobKey: row.job_key, source: row.source, queue, jobId });
    }

    res.json({
      dispatched: dispatched.length,
      candidates: candidates.rows.length,
      commands: dispatched,
    });
  } catch (err) {
    log.error({ err }, "Expiry recheck dispatch failed");
    res.status(500).json({ error: "Expiry recheck dispatch failed" });
  }
});

// ── Dead Letter Scan (manual trigger) ─────
app.post("/api/dead-letter/scan", async (req, res) => {
  const batchSize = Math.min(Number(req.body?.batchSize) || DEAD_LETTER_SCAN_BATCH_SIZE, 500);
  const force = req.body?.force !== false;
  const sources = Array.isArray(req.body?.sources)
    ? req.body.sources.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
    : undefined;

  try {
    const maintenance = await runDeadLetterMaintenance({
      batchSize,
      sources,
      force,
      intervalMs: DEAD_LETTER_SCAN_INTERVAL_MS,
      trigger: "manual",
    });

    if (maintenance.status === "skipped_lock") {
      return res.status(409).json({
        error: "dead_letter_locked",
        message: "Dead-letter scan is already running on another instance",
      });
    }

    if (maintenance.status === "skipped_not_due") {
      return res.status(202).json({ status: "skipped_not_due" });
    }

    res.json({
      status: "ok",
      batchSize,
      force,
      sources: sources ?? null,
      result: maintenance.detail,
    });
  } catch (err) {
    log.error({ err }, "Dead-letter scan API failed");
    res.status(500).json({ error: "Dead-letter scan failed" });
  }
});

// ── SSE Progress Stream ───────────────────────────────────────
app.get("/api/progress/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(`data: ${JSON.stringify(getProgress())}\n\n`);

  const listener = (state: ProgressState) => {
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  };

  onProgress(listener);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    offProgress(listener);
  });
});

// ── LinkedIn Trigger (dispatch to browser queue) ──────────────
app.post("/api/trigger", async (req, res) => {
  const { timeFilter } = req.body ?? {};
  try {
    const payload = { type: "discover_jobs" as const, source: "linkedin", timeFilter };
    const queue = routeCommand(payload);
    const jobId = await dispatch(payload);
    res.json({ status: "dispatched", queue, jobId, source: "linkedin", timeFilter });
  } catch (err) {
    log.error({ err }, "Failed to dispatch LinkedIn trigger");
    res.status(500).json({ error: "Failed to dispatch" });
  }
});


// ── Multi-Source Trigger (dispatch per source to queue) ───────
app.post("/api/trigger/multi", async (req, res) => {
  try {
    const { sources, timeFilter } = req.body ?? {};
    const config = getConfig();
    const scraperCfg = await getScraperConfig();

    const requestedSources: string[] =
      sources && sources.length > 0 ? sources : config.enabledSources;

    const dispatched: { source: string; queue: string; jobId: string }[] = [];

    for (const source of requestedSources) {
      const payload = {
        type: "discover_jobs" as const,
        source,
        keywords: scraperCfg.keywords,
        location: scraperCfg.location,
        timeFilter,
      };
      const queue = routeCommand(payload);
      const jobId = await dispatch(payload);
      dispatched.push({ source, queue, jobId });
    }

    log.info({ dispatched: dispatched.length, sources: requestedSources }, "Multi-source dispatch complete");
    res.json({
      status: "dispatched",
      mode: "multi-source",
      dispatched: dispatched.length,
      commands: dispatched,
    });
  } catch (err) {
    log.error({ err }, "Multi-source dispatch failed");
    res.status(500).json({ error: "Multi-source dispatch failed" });
  }
});

// ── Per-source trigger (dispatch single source; lease owned by worker) ──
app.post("/api/trigger/source/:source", async (req, res) => {
  const { source } = req.params;
  const { timeFilter, force } = req.body ?? {};
  try {
    const cooldown = await isSourceInCooldown(source);
    if (cooldown && !force) {
      const state = await getBreakerState(source);
      return res.status(429).json({
        error: "source_in_cooldown",
        source,
        cooldownUntil: state.cooldownUntil,
        hint: "Pass force:true to override cooldown",
      });
    }

    if (force && cooldown) {
      await forceResetBreaker(source);
      log.info({ source }, "Manual trigger force-reset breaker");
    }

    const existing = await isLeaseHeld(source);
    if (existing) {
      return res.status(409).json({
        error: "source_busy",
        source,
        currentHolder: existing.holder,
        expiresAt: existing.expiresAt,
      });
    }

    const scraperCfg = await getScraperConfig();
    const payload = {
      type: "discover_jobs" as const,
      source,
      keywords: scraperCfg.keywords,
      location: scraperCfg.location,
      timeFilter,
    };
    const queue = routeCommand(payload);
    const jobId = await dispatch(payload);
    log.info({ source, queue, jobId }, "Single-source dispatch (manual, worker will acquire lease)");
    res.json({ status: "dispatched", source, queue, jobId, timeFilter, leaseMode: "worker-owned" });
  } catch (err) {
    log.error({ err, source }, "Single-source dispatch failed");
    res.status(500).json({ error: "Dispatch failed" });
  }
});

// ── Crawl runs (per-source recent history) ────────────────────
app.get("/api/crawl-runs/latest", async (req, res) => {
  try {
    const source = req.query.source as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const conditions: string[] = [];
    const params: unknown[] = [limit];
    if (source) {
      conditions.push("source = $2");
      params.push(source);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await query(
      `SELECT id::text, task_type, source, job_key, status, http_status, error_type,
              evidence_summary, jobs_found, jobs_inserted, jobs_updated,
              started_at, finished_at, duration_ms
       FROM public.crawl_runs ${where}
       ORDER BY started_at DESC
       LIMIT $1`,
      params,
    );
    res.json({ runs: result.rows });
  } catch (err) {
    log.error({ err }, "Failed to fetch crawl runs");
    res.status(500).json({ error: "Failed to fetch crawl runs" });
  }
});

// ── Schedule (delegates to queue — scheduler container handles the interval) ──
app.post("/api/schedule", (_req, res) => {
  res.json({
    status: "info",
    message: "Scheduling is managed by the scheduler container via queue dispatch. Use /api/trigger or /api/trigger/multi for on-demand runs.",
  });
});

// ── Jobs (schema-aware, with sorting & time filters) ──────────
app.get("/api/jobs", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const source = req.query.source as string | undefined;
    const sortBy = (req.query.sortBy as string) || "posted_date";
    const order = (req.query.order as string)?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const timeRange = req.query.timeRange as string | undefined; // "1h", "6h", "24h", "1w"

    // Determine table: source-specific schema or unified view
    const table = source ? sourceTable(source) : JOBS_ALL_VIEW;

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (timeRange) {
      const hoursMap: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "1w": 168, "1m": 720 };
      const hours = hoursMap[timeRange];
      if (hours) {
        conditions.push(`created_at >= NOW() - INTERVAL '${hours} hours'`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Validate sortBy
    const allowedSorts = ["created_at", "posted_date", "company_name", "job_title"];
    const sortColumn = allowedSorts.includes(sortBy) ? sortBy : "created_at";
    const nullsLast = sortColumn === "posted_date" ? " NULLS LAST" : "";

    // Count total for pagination metadata
    const countSql = `SELECT COUNT(*)::int AS total FROM ${table} ${whereClause}`;
    const countParams = params.slice(); // copy before adding limit/offset
    const countResult = await query<{ total: number }>(countSql, countParams);
    const totalCount = countResult.rows[0]?.total ?? 0;

    const sql = `SELECT *,
      CASE
        WHEN posted_date IS NULL THEN NULL
        WHEN EXTRACT(HOUR FROM posted_date) = 0
         AND EXTRACT(MINUTE FROM posted_date) = 0
         AND EXTRACT(SECOND FROM posted_date) = 0 THEN 'day'
        ELSE 'datetime'
      END AS posted_date_precision,
      CASE
        WHEN posted_date IS NOT NULL THEN EXTRACT(EPOCH FROM (created_at - posted_date))::int
        ELSE NULL
      END AS freshness_gap_seconds
    FROM ${table} ${whereClause} ORDER BY ${sortColumn} ${order}${nullsLast} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      jobs: result.rows,
      pagination: {
        page,
        pageSize: limit,
        totalCount,
        totalPages,
        hasMore: offset + limit < totalCount,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to fetch jobs");
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// ── Jobs Stats (per-schema, enhanced) ─────────────────────────
app.get("/api/jobs/stats", async (req, res) => {
  try {
    const source = req.query.source as string | undefined;
    const table = source ? sourceTable(source) : JOBS_ALL_VIEW;

    const [overview, sourceBreakdown, duplicates, recentActivity] = await Promise.all([
      query(`
        SELECT 
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE state = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE state = 'applied')::int AS applied,
          COUNT(*) FILTER (WHERE state = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE state = 'ignored')::int AS ignored,
          COUNT(*) FILTER (WHERE state = 'suspended')::int AS suspended,
          COUNT(DISTINCT ats_platform) FILTER (WHERE ats_platform IS NOT NULL)::int AS ats_platforms,
          COUNT(DISTINCT company_name)::int AS companies,
          COUNT(*) FILTER (WHERE can_sponsor = TRUE)::int AS sponsor_jobs,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')::int AS last_1h,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h
        FROM ${table}
      `),
      query(`
        SELECT source, COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS today
        FROM ${JOBS_ALL_VIEW} GROUP BY source ORDER BY count DESC
      `),
      query(`
        SELECT COUNT(DISTINCT content_hash)::int AS unique_jobs,
               COUNT(*)::int AS total_listings
        FROM ${table} WHERE content_hash IS NOT NULL
      `),
      // Recent activity: jobs per hour for last 24h
      query(`
        SELECT
          date_trunc('hour', created_at) AS hour,
          COUNT(*)::int AS count
        FROM ${table}
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY hour
        ORDER BY hour ASC
      `),
    ]);

    res.json({
      ...(overview.rows[0] ?? {}),
      bySource: sourceBreakdown.rows,
      duplicateInfo: duplicates.rows[0] ?? {},
      hourlyActivity: recentActivity.rows,
    });
  } catch (err) {
    log.error({ err }, "Failed to fetch stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── Cross-platform duplicates ─────────────────────────────────
app.get("/api/jobs/duplicates", async (_req, res) => {
  try {
    const result = await query(`
      SELECT content_hash, 
             array_agg(source) AS sources,
             array_agg(source_url) AS urls,
             MIN(company_name) AS company_name,
             MIN(job_title) AS job_title,
             COUNT(*)::int AS platform_count
      FROM ${CONTENT_INDEX_TABLE}
      GROUP BY content_hash
      HAVING COUNT(*) > 1
      ORDER BY platform_count DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch duplicates" });
  }
});

// ── Schedule state (per-source) ───────────────────────────────
app.get("/api/schedule/state", async (_req, res) => {
  try {
    const result = await query(
      `SELECT source, interval_ms, last_dispatched_at, next_dispatch_at,
              lease_holder, lease_acquired_at, lease_expires_at,
              cooldown_until, cooldown_reason, consecutive_failures,
              last_failure_at, enabled, updated_at
       FROM public.source_schedule_state
       ORDER BY source`,
    );
    res.json({ schedules: result.rows });
  } catch (err) {
    log.error({ err }, "Failed to fetch schedule state");
    res.status(500).json({ error: "Failed to fetch schedule state" });
  }
});

// ── Breaker state (per-source) ────────────────────────────────
app.get("/api/breaker/:source", async (req, res) => {
  try {
    const state = await getBreakerState(req.params.source);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: "Failed to get breaker state" });
  }
});

app.post("/api/breaker/:source/reset", async (req, res) => {
  try {
    await forceResetBreaker(req.params.source);
    res.json({ status: "reset", source: req.params.source });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset breaker" });
  }
});

// ── Apply discovery stats & recent results ────────────────────
app.get("/api/apply-discovery/stats", async (req, res) => {
  try {
    const source = req.query.source as string | undefined;
    const stats = await getApplyDiscoveryStats(source);
    res.json(stats);
  } catch (err) {
    log.error({ err }, "Failed to fetch apply discovery stats");
    res.status(500).json({ error: "Failed to fetch apply discovery stats" });
  }
});

app.get("/api/apply-discovery/recent", async (req, res) => {
  try {
    const source = req.query.source as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const results = await getRecentApplyDiscoveries(source, limit);
    res.json({ results });
  } catch (err) {
    log.error({ err }, "Failed to fetch apply discoveries");
    res.status(500).json({ error: "Failed to fetch apply discoveries" });
  }
});

// ── Dispatch resolve_apply for a specific job ─────────────────
app.post("/api/apply-discovery/resolve", async (req, res) => {
  const { jobKey, source, applyUrl, sourceDescUrl } = req.body ?? {};
  if (!jobKey || !source || !applyUrl) {
    return res.status(400).json({ error: "jobKey, source, and applyUrl are required" });
  }
  try {
    const payload = {
      type: "resolve_apply" as const,
      jobKey,
      source,
      applyUrl,
      sourceDescUrl,
    };
    const queue = routeCommand(payload);
    const jobId = await dispatch(payload);
    res.json({ status: "dispatched", queue, jobId, jobKey });
  } catch (err) {
    log.error({ err }, "Apply discovery dispatch failed");
    res.status(500).json({ error: "Apply discovery dispatch failed" });
  }
});

// ── Batch backfill dispatch for resolve_apply ──────────────────
app.post("/api/apply-discovery/backfill", async (req, res) => {
  try {
    const source = typeof req.body?.source === "string" ? req.body.source : undefined;
    const limit = Math.min(Number(req.body?.limit) || 50, 500);
    const result = await dispatchApplyDiscoveryBackfill({ source, limit });
    res.json({ source: source ?? "all", ...result });
  } catch (err) {
    log.error({ err }, "Apply discovery backfill dispatch failed");
    res.status(500).json({ error: "Apply discovery backfill dispatch failed" });
  }
});

// ── Apply discovery: final form URLs (for verification) ──────
app.get("/api/apply-discovery/final-forms", async (req, res) => {
  try {
    const source = req.query.source as string | undefined;
    const status = (req.query.status as string) || "final_form_reached";
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;

    const conditions: string[] = [`adr.apply_discovery_status = $1`];
    const params: unknown[] = [status];
    let idx = 2;

    if (source) {
      conditions.push(`adr.source = $${idx++}`);
      params.push(source);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countRes = await query<{ cnt: number }>(
      `SELECT COUNT(*)::int as cnt FROM apply_discovery_results adr ${where}`,
      params,
    );
    const total = countRes.rows[0]?.cnt ?? 0;

    const dataParams = [...params, limit, offset];
    const rows = await query(
      `SELECT 
        adr.job_key,
        adr.source,
        jc.company,
        jc.title,
        jc.location,
        adr.apply_discovery_status as status,
        adr.initial_apply_url,
        adr.resolved_apply_url,
        adr.final_form_url,
        adr.form_provider,
        adr.resolver_version,
        (adr.form_schema_snapshot->>'fieldCount')::int as field_count,
        adr.login_required,
        adr.registration_required,
        adr.last_resolution_error,
        adr.updated_at
      FROM apply_discovery_results adr
      JOIN jobs_current jc ON jc.job_key = adr.job_key
      ${where}
      ORDER BY adr.updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}`,
      dataParams,
    );

    // Domain distribution
    const domainParams = params.slice(0, source ? 2 : 1);
    const domainRes = status === "final_form_reached" ? await query(
      `SELECT 
        substring(adr.resolved_apply_url from '://([^/]+)') as domain,
        COUNT(*)::int as cnt
      FROM apply_discovery_results adr
      ${where}
        AND adr.resolved_apply_url IS NOT NULL
      GROUP BY domain
      ORDER BY cnt DESC
      LIMIT 30`,
      domainParams,
    ) : { rows: [] };

    res.json({
      results: rows.rows,
      total,
      limit,
      offset,
      domains: domainRes.rows,
    });
  } catch (err) {
    log.error({ err }, "Failed to fetch final forms");
    res.status(500).json({ error: "Failed to fetch final forms" });
  }
});

// ── Release lease (manual cleanup) ────────────────────────────

app.post("/api/lease/:source/release", async (req, res) => {
  const { source } = req.params;
  const { holder } = req.body ?? {};
  try {
    const released = await releaseLease(source, holder ?? "manual-trigger");
    res.json({ released, source });
  } catch (err) {
    res.status(500).json({ error: "Failed to release lease" });
  }
});

setInterval(() => {
  runDeadLetterMaintenance({
    batchSize: DEAD_LETTER_SCAN_BATCH_SIZE,
    force: false,
    intervalMs: DEAD_LETTER_SCAN_INTERVAL_MS,
    trigger: "interval",
  }).catch((err: unknown) => {
    log.error({ err }, "Scheduled dead-letter maintenance failed");
  });
}, DEAD_LETTER_MAINTENANCE_POLL_MS);

setTimeout(() => {
  runDeadLetterMaintenance({
    batchSize: DEAD_LETTER_SCAN_BATCH_SIZE,
    force: false,
    intervalMs: DEAD_LETTER_SCAN_INTERVAL_MS,
    trigger: "startup",
  }).catch((err: unknown) => {
    log.error({ err }, "Initial dead-letter maintenance failed");
  });
}, 5000);

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  log.info(`API Server & Frontend Dashboard running on http://localhost:${PORT}`);
});
