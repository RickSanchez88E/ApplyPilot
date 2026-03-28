import { useState } from 'react';
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

function AnimatedNumber({ value }: { value: number }) {
  return <span className="font-mono">{value.toLocaleString()}</span>;
}

export function OverviewPage({ locale }: { locale: Locale }) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [applyStats, setApplyStats] = useState<ApplyStats | null>(null);

  usePolling(async (signal) => {
    const [statsResp, applyResp] = await Promise.all([
      fetch('/api/jobs/stats', { signal }),
      fetch('/api/apply-discovery/stats', { signal }),
    ]);
    setStats(await statsResp.json());
    setApplyStats(await applyResp.json());
  }, 30000, []);

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

          {applyStats && applyStats.total > 0 && (
            <div className="panel p-5">
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">{t('overview.applyResolution', locale)}</h3>
              <div className="text-sm font-mono space-y-1">
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">{t('overview.formReached', locale)}</span>
                  <span className="text-[var(--color-success)]">{applyStats.byStatus.final_form_reached ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">{t('overview.descOnly', locale)}</span>
                  <span className="text-[var(--color-text)]">{applyStats.byStatus.platform_desc_only ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">{t('overview.loginRequired', locale)}</span>
                  <span className="text-[var(--color-warning)]">{loginCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">{t('overview.blocked', locale)}</span>
                  <span className="text-[var(--color-danger)]">{applyStats.byStatus.blocked ?? 0}</span>
                </div>
                {applyStats.coverage && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-text-dim)]">{t('overview.coverage', locale)}</span>
                      <span className="text-[var(--color-text)]">{applyStats.coverage.resolvedRate.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-text-dim)]">{t('overview.unresolvedJobs', locale)}</span>
                      <span className="text-[var(--color-warning)]">{applyStats.coverage.unresolvedJobs}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <OverviewProgress locale={locale} />
    </div>
  );
}
