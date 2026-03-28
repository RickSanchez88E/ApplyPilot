import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { SOURCES } from '../lib/utils';
import { OverviewProgress } from './PlatformProgress';
import { KeywordConfig } from './KeywordConfig';

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

function AnimatedNumber({ value }: { value: number }) {
  return <span className="font-mono">{value.toLocaleString()}</span>;
}

export function OverviewPage() {
  const [stats, setStats] = useState<OverviewStats | null>(null);

  useEffect(() => {
    const fetch_ = () => {
      fetch('/api/jobs/stats')
        .then(r => r.json())
        .then(setStats)
        .catch(() => {});
    };
    fetch_();
    const iv = setInterval(fetch_, 30000);
    return () => clearInterval(iv);
  }, []);

  if (!stats) return <div className="h-40 panel animate-pulse" />;

  const kpis = [
    { label: 'Total Jobs', value: stats.total },
    { label: 'Last 24h', value: stats.last_24h },
    { label: 'Last 1h', value: stats.last_1h },
    { label: 'Sponsorship', value: stats.sponsor_jobs },
    { label: 'Companies', value: stats.companies },
  ];

  const maxCount = Math.max(...(stats.bySource || []).map(s => s.count), 1);

  return (
    <div className="space-y-5">
      {/* KPI row */}
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
        {/* Source distribution */}
        <div className="lg:col-span-2 panel p-5">
          <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-4">Source Distribution</h3>
          <div className="space-y-2.5">
            {(stats.bySource || []).map(src => {
              const pct = Math.max((src.count / maxCount) * 100, 2);
              const meta = SOURCES[src.source];
              return (
                <div key={src.source} className="flex items-center gap-3">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-medium w-16 justify-center ${meta?.bg ?? 'bg-gray-100'} ${meta?.text ?? 'text-gray-700'}`}>
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

        {/* Sidebar: config + duplicates */}
        <div className="space-y-5">
          <KeywordConfig />
          {stats.duplicateInfo && (
            <div className="panel p-5">
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">Cross-Platform Duplicates</h3>
              <div className="text-sm font-mono space-y-1">
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">Unique hashes</span>
                  <span className="text-[var(--color-text)]">{stats.duplicateInfo.unique_jobs?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-dim)]">Total listings</span>
                  <span className="text-[var(--color-text)]">{stats.duplicateInfo.total_listings?.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Latest runs overview */}
      <OverviewProgress />
    </div>
  );
}
