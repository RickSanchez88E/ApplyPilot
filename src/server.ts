import type { BatchResult } from "./index.js";
import { startScraper } from "./index.js";
import { query } from "./db/client.js";
import { runMultiSourceScrape, getAdapterCapabilities } from "./sources/orchestrator.js";
import { getConfig, TIME_FILTER_PRESETS } from "./shared/config.js";
import { sourceTable, JOBS_ALL_VIEW, ALL_SOURCE_NAMES, CONTENT_INDEX_TABLE } from "./db/schema-router.js";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChildLogger } from "./lib/logger.js";
import { getProgress, onProgress, offProgress, type ProgressState } from "./lib/progress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createChildLogger({ module: "api-server" });
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

let isScraping = false;
let lastScrapeResult: BatchResult | null = null;
let currentSchedule: ReturnType<typeof setInterval> | null = null;
let nextRunAt: Date | null = null;
const serverStartedAt = Date.now();

// ── Status ────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    isScraping,
    scheduleActive: currentSchedule !== null,
    nextRunAt,
    progress: getProgress(),
    lastResult: lastScrapeResult,
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
      isScraping,
      scheduleActive: currentSchedule !== null,
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

// ── LinkedIn Trigger (with time filter) ───────────────────────
app.post("/api/trigger", async (req, res) => {
  if (isScraping) {
    return res.status(400).json({ error: "Scraping already in progress" });
  }

  isScraping = true;
  const { timeFilter } = req.body ?? {};
  res.json({ status: "started", timeFilter: timeFilter ?? "multi-pass" });

  try {
    log.info({ timeFilter }, "API triggered LinkedIn scrape batch");
    const result = await startScraper({ force: true, timeFilter });
    lastScrapeResult = result;
  } catch (err) {
    log.error({ err }, "API triggered scrape failed");
  } finally {
    isScraping = false;
  }
});


// ── Multi-Source Trigger ──────────────────────────────────────
app.post("/api/trigger/multi", async (req, res) => {
  if (isScraping) {
    return res.status(400).json({ error: "Scraping already in progress" });
  }

  isScraping = true;

  try {
    const config = getConfig();
    const { sources, timeFilter } = req.body ?? {};

    // REV-1: Validate time filter against source capabilities.
    // Only pass timeFilter to sources that truly support it.
    const caps = getAdapterCapabilities();
    const requestedSources: string[] = sources ?? [];

    const timeFilterMap: Record<string, number> = {
      r86400: 1,         // 24 hours → 1 day
      r604800: 7,        // 1 week → 7 days
      r2592000: 30,      // 1 month → 30 days
    };
    const maxAgeDays = timeFilter ? timeFilterMap[timeFilter] : undefined;

    // Split sources into time-supported and non-time-supported groups
    const timeSupported = requestedSources.filter(s =>
      caps.find(c => c.name === s)?.supportsNativeTimeFilter
    );
    const noTimeSupport = requestedSources.filter(s =>
      !caps.find(c => c.name === s)?.supportsNativeTimeFilter
    );

    log.info(
      { timeSupported, noTimeSupport, maxAgeDays, timeFilter },
      "API triggered multi-source scrape (capability-aware)"
    );

    res.json({
      status: "started",
      mode: "multi-source",
      timeFilterAppliedTo: maxAgeDays ? timeSupported : [],
      noTimeFilter: maxAgeDays ? noTimeSupport : requestedSources,
    });

    // FIX (2026-03-26): All selected sources must ALWAYS execute.
    // Previously, when timeFilter was not sent, timeSupported sources (Reed, Jooble)
    // were silently skipped because of `timeSupported.length > 0 && maxAgeDays`.
    //
    // New logic:
    // - If maxAgeDays is set: run timeSupported with it, run noTimeSupport without
    // - If maxAgeDays is NOT set: run ALL sources together without any time filter
    if (maxAgeDays) {
      // Run time-filtered sources with maxAgeDays
      if (timeSupported.length > 0) {
        const result1 = await runMultiSourceScrape(
          config.searchKeywords,
          config.searchLocation,
          timeSupported,
          maxAgeDays,
        );
        log.info(result1, "Time-filtered sources complete");
      }

      // Run non-time-filtered sources WITHOUT maxAgeDays
      if (noTimeSupport.length > 0) {
        const result2 = await runMultiSourceScrape(
          config.searchKeywords,
          config.searchLocation,
          noTimeSupport,
          undefined,
        );
        log.info(result2, "Non-time-filtered sources complete");
      }
    } else {
      // No time filter → full fetch for ALL selected sources in one batch
      const result = await runMultiSourceScrape(
        config.searchKeywords,
        config.searchLocation,
        requestedSources.length > 0 ? requestedSources : undefined,
        undefined,
      );
      log.info(result, "Multi-source scrape (full fetch) complete");
    }
  } catch (err) {
    log.error({ err }, "Multi-source scrape failed");
  } finally {
    isScraping = false;
  }
});

// ── Schedule ──────────────────────────────────────────────────
app.post("/api/schedule", (req, res) => {
  const { action, intervalMs } = req.body;
  if (action === "start") {
    if (currentSchedule) clearInterval(currentSchedule);

    const interval = intervalMs || 3600000;
    currentSchedule = setInterval(async () => {
      if (!isScraping) {
        try {
          isScraping = true;
          log.info("Scheduled trigger firing");
          lastScrapeResult = await startScraper({ force: false });
        } catch (e) {
          log.error({ err: e }, "Scheduled scrape failed");
        } finally {
          isScraping = false;
          nextRunAt = new Date(Date.now() + interval);
        }
      }
    }, interval);

    nextRunAt = new Date(Date.now() + interval);
    res.json({ status: "scheduled", nextRunAt });
  } else {
    if (currentSchedule) clearInterval(currentSchedule);
    currentSchedule = null;
    nextRunAt = null;
    res.json({ status: "stopped" });
  }
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

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  log.info(`API Server & Frontend Dashboard running on http://localhost:${PORT}`);
});
