/**
 * Source Concurrency Strategy — per-source browser concurrency and throttling config.
 *
 * Policy:
 *   - jooble: low concurrency, slow (conservative due to CF protection)
 *   - hn_hiring / devitjobs: higher throughput (simple, no login walls)
 *   - linkedin / reed / remoteok: conservative, login-dependent
 *
 * Overridable via env: SOURCE_CONCURRENCY_OVERRIDES=jooble:1:3000,linkedin:1:2000
 */

import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-concurrency" });

export interface SourceConcurrencyConfig {
  /** Max simultaneous pages for this source. */
  maxPages: number;
  /** Delay (ms) between successive page opens for this source. */
  delayBetweenPagesMs: number;
  /** Per-page navigation timeout (ms). */
  navigationTimeoutMs: number;
  /** Strategy notes for documentation. */
  notes: string;
}

const DEFAULT_STRATEGIES: Record<string, SourceConcurrencyConfig> = {
  jooble: {
    maxPages: 1,
    delayBetweenPagesMs: 3000,
    navigationTimeoutMs: 25000,
    notes: "Conservative: CF-protected, slow-mode, single-page only",
  },
  linkedin: {
    maxPages: 1,
    delayBetweenPagesMs: 2000,
    navigationTimeoutMs: 20000,
    notes: "Conservative: anti-scraping, login-dependent, start with 1 page",
  },
  reed: {
    maxPages: 1,
    delayBetweenPagesMs: 2000,
    navigationTimeoutMs: 20000,
    notes: "Conservative: login wall, single-page until login stable",
  },
  remoteok: {
    maxPages: 1,
    delayBetweenPagesMs: 2000,
    navigationTimeoutMs: 15000,
    notes: "Conservative: login-dependent aggregator, single-page",
  },
  hn_hiring: {
    maxPages: 3,
    delayBetweenPagesMs: 500,
    navigationTimeoutMs: 15000,
    notes: "High throughput: simple static pages, no login walls, no CF",
  },
  devitjobs: {
    maxPages: 3,
    delayBetweenPagesMs: 500,
    navigationTimeoutMs: 15000,
    notes: "High throughput: simple static pages, no login walls, no CF",
  },
};

const FALLBACK_CONFIG: SourceConcurrencyConfig = {
  maxPages: 1,
  delayBetweenPagesMs: 2000,
  navigationTimeoutMs: 20000,
  notes: "Fallback: unknown source, conservative defaults",
};

function parseOverrides(): Record<string, Partial<SourceConcurrencyConfig>> {
  const raw = process.env.SOURCE_CONCURRENCY_OVERRIDES;
  if (!raw) return {};
  const result: Record<string, Partial<SourceConcurrencyConfig>> = {};
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 2) continue;
    const source = parts[0]!;
    const maxPages = parseInt(parts[1] ?? "", 10);
    const delayMs = parts[2] ? parseInt(parts[2], 10) : undefined;
    if (source && Number.isFinite(maxPages)) {
      result[source] = {
        maxPages,
        ...(delayMs !== undefined && Number.isFinite(delayMs) ? { delayBetweenPagesMs: delayMs } : {}),
      };
    }
  }
  return result;
}

let _strategies: Record<string, SourceConcurrencyConfig> | null = null;

function getStrategies(): Record<string, SourceConcurrencyConfig> {
  if (_strategies) return _strategies;
  const overrides = parseOverrides();
  _strategies = { ...DEFAULT_STRATEGIES };
  for (const [source, override] of Object.entries(overrides)) {
    const base = _strategies[source] ?? FALLBACK_CONFIG;
    _strategies[source] = { ...base, ...override };
    log.info({ source, override }, "Source concurrency override applied");
  }
  return _strategies;
}

export function getSourceConcurrency(source: string): SourceConcurrencyConfig {
  const strategies = getStrategies();
  return strategies[source] ?? FALLBACK_CONFIG;
}

export function getAllSourceConcurrency(): Record<string, SourceConcurrencyConfig> {
  return { ...getStrategies() };
}

/** Per-source throttle: tracks last page open time. */
const _lastPageOpenTime: Record<string, number> = {};

export async function enforceSourceDelay(source: string): Promise<void> {
  const config = getSourceConcurrency(source);
  const lastOpen = _lastPageOpenTime[source] ?? 0;
  const elapsed = Date.now() - lastOpen;
  const remaining = config.delayBetweenPagesMs - elapsed;
  if (remaining > 0) {
    log.debug({ source, delayMs: remaining }, "Enforcing inter-page delay");
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  _lastPageOpenTime[source] = Date.now();
}
