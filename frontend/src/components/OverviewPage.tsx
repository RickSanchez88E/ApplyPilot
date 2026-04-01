import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { SOURCES } from '../lib/utils';
import { t, type Locale } from '../lib/i18n';
import { OverviewProgress } from './PlatformProgress';
import { KeywordConfig } from './KeywordConfig';
import { usePolling } from '../hooks/usePolling';

interface SourceStat {
  source: string;
  count: number;
  today: number;
}

interface OverviewStats {
  total: number;
  last_1h: number;
  last_24h: number;
  sponsor_jobs: number;
  companies: number;
  bySource: SourceStat[];
  duplicateInfo: { unique_jobs: number; total_listings: number };
}

interface ApplyStats {
  total: number;
  byStatus: Record<string, number>;
  coverage?: {
    resolvedJobs: number;
    unresolvedJobs: number;
    totalJobs: number;
    resolvedRate: number;
  };
}

interface PerSourceApplyStats {
  source: string;
  total: number;
  final_form: number;
  requires_login: number;
  platform_desc: number;
  blocked: number;
  failed: number;
  unresolved: number;
}

const APPLY_STATUS_COLORS: Record<string, { bg: string; label: string }> = {
  final_form: { bg: 'var(--color-success)', label: 'Final Form' },
  requires_login: { bg: 'var(--color-warning)', label: 'Login Required' },
  platform_desc: { bg: '#94a3b8', label: 'Desc Only' },
  blocked: { bg: 'var(--color-danger)', label: 'Blocked' },
  failed: { bg: '#6b7280', label: 'Failed' },
  unresolved: { bg: '#e2e8f0', label: 'Unresolved' },
};

const SOURCE_ORDER = ['linkedin', 'reed', 'hn_hiring', 'devitjobs', 'remoteok'];

function AnimatedNumber({ value }: { value: number }) {
  return <span className="font-mono">{value.toLocaleString()}</span>;
}

export function OverviewPage({ locale }: { locale: Locale }) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [applyStats, setApplyStats] = useState<ApplyStats | null>(null);
  const [perSourceApply, setPerSourceApply] = useState<PerSourceApplyStats[]>([]);
  const [dlqRunning, setDlqRunning] = useState(false);
  const [dlqMessage, setDlqMessage] = useState<string | null>(null);

  usePolling(async (signal) => {
    const [statsResp, applyResp] = await Promise.all([
      fetch('/api/jobs/stats', { signal }),
      fetch('/api/apply-discovery/stats', { signal }),
    ]);
    setStats(await statsResp.json());
    setApplyStats(await applyResp.json());
  }, 30000, []);

  // Fetch per-source apply stats on mount
  useEffect(() => {
    async function fetchPerSource() {
      try {
        const results: PerSourceApplyStats[] = [];
        for (const src of SOURCE_ORDER) {
          const resp = await fetch(`/api/apply-discovery/stats?source=${src}`);
          const data = await resp.json();
          const loginCount = (data.byStatus?.requires_login ?? 0)
            + (data.byStatus?.oauth_google ?? 0)
            + (data.byStatus?.oauth_linkedin ?? 0);
          results.push({
            source: src,
            total: data.coverage?.totalJobs ?? 0,
            final_form: data.byStatus?.final_form_reached ?? 0,
            requires_login: loginCount,
            platform_desc: data.byStatus?.platform_desc_only ?? 0,
            blocked: data.byStatus?.blocked ?? 0,
            failed: data.byStatus?.failed ?? 0,
            unresolved: data.coverage?.unresolvedJobs ?? 0,
          });
        }
        setPerSourceApply(results);
      } catch {
        // ignore
      }
    }
    fetchPerSource();
    const interval = setInterval(fetchPerSource, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleRunGlobalDlq = async () => {
    setDlqRunning(true);
    setDlqMessage(null);
    try {
      const resp = await fetch("/api/dead-letter/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 200, force: true }),
      });
      const data = await resp.json() as Record<string, unknown>;
      if (!resp.ok) throw new Error((data.error as string) || ("HTTP " + resp.status));
      const detail = data.result as Record<string, unknown> | undefined;
      const scanned = (detail?.scanned as Record<string, number> | undefined)?.checked ?? 0;
      const deleted = (detail?.scanned as Record<string, number> | undefined)?.deleted ?? 0;
      setDlqMessage(t("platform.dlqDone", locale) + ": " + deleted + "/" + scanned);
      setTimeout(() => setDlqMessage(null), 6000);
    } catch (err) {
      setDlqMessage(err instanceof Error ? err.message : "DLQ failed");
    } finally {
      setDlqRunning(false);
    }
  };

  if (!stats) return <div className="h-40 panel animate-pulse" />;

  const kpis = [
    { label: t('overview.totalJobs', locale), value: stats.total },
    { label: t('overview.last24h', locale), value: stats.last_24h },
    { label: t('overview.last1h', locale), value: stats.last_1h },
    { label: t('overview.sponsorship', locale), value: stats.sponsor_jobs },
    { label: t('overview.companies', locale), value: stats.companies },
  ];

  const maxCount = Math.max(...(stats.bySource || []).map(s => s.count), 1);
  const loginCount = (applyStats?.byStatus.requires_login ?? 0)
    + (applyStats?.byStatus.oauth_google ?? 0)
    + (applyStats?.byStatus.oauth_linkedin ?? 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {kpis.map((kpi, i) => (
          <motion.div
            key={kpi.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="panel p-4"
          >
            <div className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-dim)] font-mono mb-1">{kpi.label}</div>
            <div className="text-2xl font-semibold tracking-tight"><AnimatedNumber value={kpi.value} /></div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 panel p-5">
          <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-4">{t('overview.sourceDistribution', locale)}</h3>
          <div className="space-y-2.5">
            {(stats.bySource || []).map(src => {
              const pct = Math.max((src.count / maxCount) * 100, 2);
              const meta = SOURCES[src.source];
              return (
                <div key={src.source} className="flex items-center gap-3">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-medium w-16 justify-center ${meta?.bg ?? 'bg-[var(--color-surface)]'} ${meta?.text ?? 'text-[var(--color-text-secondary)]'}`}>
                    {meta?.label ?? src.source}
                  </span>
                  <div className="flex-1 h-4 bg-[var(--color-surface)] rounded overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8 }}
                      className="h-full bg-[var(--color-accent)] rounded"
                    />
                  </div>
                  <span className="text-xs font-mono text-[var(--color-text-secondary)] w-14 text-right">{src.count}</span>
                  {src.today > 0 && (
                    <span className="text-[10px] font-mono text-[var(--color-success)] bg-[var(--color-success-light)] px-1.5 py-0.5 rounded">+{src.today}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-5">
          <div className="panel p-5">
            <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">DLQ</h3>
            <button
              onClick={handleRunGlobalDlq}
              disabled={dlqRunning}
              className="w-full flex justify-center items-center gap-2 py-2 px-3 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] text-sm font-medium hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-all disabled:opacity-40"
            >
              {dlqRunning ? t("platform.dlqRunning", locale) : t("platform.runDlq", locale)}
            </button>
            {dlqMessage && (
              <p className="text-[11px] font-mono text-[var(--color-text-secondary)] mt-2 text-center">{dlqMessage}</p>
            )}
          </div>
          <KeywordConfig locale={locale} />
          {stats.duplicateInfo && (
            <div className="panel p-5">
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">{t('overview.crossPlatformDuplicates', locale)}</h3>
              <div className="text-sm font-mono space-y-1">
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">{t('overview.uniqueHashes', locale)}</span>
                  <span className="text-[var(--color-text)]">{stats.duplicateInfo.unique_jobs?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">{t('overview.totalListings', locale)}</span>
                  <span className="text-[var(--color-text)]">{stats.duplicateInfo.total_listings?.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Per-source apply resolution stacked bar */}
      {perSourceApply.length > 0 && (
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono">
              {locale === 'zh' ? '按平台解析状态' : 'Apply Resolution by Source'}
            </h3>
            {applyStats?.coverage && (
              <span className="text-xs font-mono text-[var(--color-text-dim)]">
                {locale === 'zh' ? '总覆盖率' : 'Coverage'}: <span className="text-[var(--color-text)] font-semibold">{applyStats.coverage.resolvedRate.toFixed(1)}%</span>
              </span>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
            {Object.entries(APPLY_STATUS_COLORS).map(([key, { bg, label }]) => (
              <span key={key} className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--color-text-dim)]">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: bg }} />
                {label}
              </span>
            ))}
          </div>

          {/* Stacked bars */}
          <div className="space-y-2">
            {perSourceApply.map((src) => {
              const meta = SOURCES[src.source];
              const total = src.total || 1;
              const segments = [
                { key: 'final_form', value: src.final_form },
                { key: 'requires_login', value: src.requires_login },
                { key: 'platform_desc', value: src.platform_desc },
                { key: 'blocked', value: src.blocked },
                { key: 'failed', value: src.failed },
                { key: 'unresolved', value: src.unresolved },
              ];

              return (
                <div key={src.source} className="flex items-center gap-3">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-medium w-20 justify-center ${meta?.bg ?? 'bg-[var(--color-surface)]'} ${meta?.text ?? 'text-[var(--color-text-secondary)]'}`}>
                    {meta?.label ?? src.source}
                  </span>

                  <div className="flex-1 h-5 bg-[var(--color-surface)] rounded overflow-hidden flex">
                    {segments.map(seg => {
                      const pct = (seg.value / total) * 100;
                      if (pct < 0.5) return null;
                      const colors = APPLY_STATUS_COLORS[seg.key];
                      return (
                        <motion.div
                          key={seg.key}
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.6 }}
                          className="h-full"
                          style={{ background: colors.bg }}
                          title={`${colors.label}: ${seg.value} (${pct.toFixed(1)}%)`}
                        />
                      );
                    })}
                  </div>

                  <span className="text-xs font-mono text-[var(--color-text-secondary)] w-12 text-right tabular-nums">{src.total}</span>
                  {src.final_form > 0 && (
                    <span className="text-[10px] font-mono text-[var(--color-success)] w-10 text-right tabular-nums">
                      {((src.final_form / total) * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Global summary row */}
          {applyStats && (
            <div className="mt-4 pt-3 border-t border-[var(--color-border)] grid grid-cols-3 md:grid-cols-6 gap-2">
              <div className="text-center">
                <div className="text-sm font-semibold text-[var(--color-success)] tabular-nums">{applyStats.byStatus.final_form_reached ?? 0}</div>
                <div className="text-[9px] font-mono text-[var(--color-text-dim)] uppercase">{t('overview.formReached', locale)}</div>
              </div>
              <div className="text-center">
                <div className="text-sm font-semibold tabular-nums">{applyStats.byStatus.platform_desc_only ?? 0}</div>
                <div className="text-[9px] font-mono text-[var(--color-text-dim)] uppercase">{t('overview.descOnly', locale)}</div>
              </div>
              <div className="text-center">
                <div className="text-sm font-semibold text-[var(--color-warning)] tabular-nums">{loginCount}</div>
                <div className="text-[9px] font-mono text-[var(--color-text-dim)] uppercase">{t('overview.loginRequired', locale)}</div>
              </div>
              <div className="text-center">
                <div className="text-sm font-semibold text-[var(--color-danger)] tabular-nums">{applyStats.byStatus.blocked ?? 0}</div>
                <div className="text-[9px] font-mono text-[var(--color-text-dim)] uppercase">{t('overview.blocked', locale)}</div>
              </div>
              <div className="text-center">
                <div className="text-sm font-semibold text-[var(--color-text-dim)] tabular-nums">{applyStats.byStatus.failed ?? 0}</div>
                <div className="text-[9px] font-mono text-[var(--color-text-dim)] uppercase">Failed</div>
              </div>
              {applyStats.coverage && (
                <div className="text-center">
                  <div className="text-sm font-semibold text-[var(--color-text)] tabular-nums">{applyStats.coverage.unresolvedJobs}</div>
                  <div className="text-[9px] font-mono text-[var(--color-text-dim)] uppercase">{t('overview.unresolvedJobs', locale)}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <OverviewProgress locale={locale} />
    </div>
  );
}
