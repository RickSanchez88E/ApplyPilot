import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { t, type Locale } from '../lib/i18n';

interface CrawlRun {
  id: string;
  task_type: string;
  source: string;
  status: string;
  jobs_found: number | null;
  jobs_inserted: number | null;
  jobs_updated: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  evidence_summary: string | null;
  error_type: string | null;
}

const STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  running:   { dot: 'bg-[var(--color-accent)]', text: 'text-[var(--color-accent)]' },
  completed: { dot: 'bg-[var(--color-success)]', text: 'text-[var(--color-success)]' },
  failed:    { dot: 'bg-[var(--color-danger)]', text: 'text-[var(--color-danger)]' },
  cancelled: { dot: 'bg-[var(--color-warning)]', text: 'text-[var(--color-warning)]' },
};

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function PlatformProgress({ source, locale }: { source: string; locale?: Locale }) {
  const [runs, setRuns] = useState<CrawlRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRuns = () => {
      fetch(`/api/crawl-runs/latest?source=${source}&limit=8`)
        .then(r => r.json())
        .then(data => { setRuns(data.runs || []); setLoading(false); })
        .catch(() => setLoading(false));
    };
    fetchRuns();
    const iv = setInterval(fetchRuns, 15000);
    return () => clearInterval(iv);
  }, [source]);

  if (loading) return <div className="panel p-4 h-24 animate-pulse" />;
  if (runs.length === 0) return (
    <div className="panel p-4">
      <p className="text-xs font-mono text-[var(--color-text-dim)]">{t('progress.noRuns', locale)}</p>
    </div>
  );

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono">{t('progress.recentRuns', locale)}</h3>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        <AnimatePresence>
          {runs.map((run) => {
            const style = STATUS_STYLES[run.status] || STATUS_STYLES.running;
            return (
              <motion.div
                key={run.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-4 py-2.5 flex items-center gap-3 text-xs font-mono"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot} ${run.status === 'running' ? 'animate-pulse' : ''}`} />
                <span className={`w-16 shrink-0 font-medium ${style.text}`}>{t(`progress.${run.status}`, locale)}</span>
                <span className="text-[var(--color-text-dim)] w-20 shrink-0">{run.task_type.replace(/_/g, ' ')}</span>
                <span className="text-[var(--color-text-secondary)] w-12 text-right shrink-0">{formatDuration(run.duration_ms)}</span>
                {run.jobs_found != null && (
                  <span className="text-[var(--color-text-dim)]">
                    {run.jobs_found} found · {run.jobs_inserted ?? 0} new
                  </span>
                )}
                {run.evidence_summary && !run.jobs_found && (
                  <span className="text-[var(--color-text-dim)] truncate max-w-[200px]" title={run.evidence_summary}>
                    {run.evidence_summary}
                  </span>
                )}
                <span className="ml-auto text-[var(--color-text-dim)] shrink-0">{formatTime(run.started_at)}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function OverviewProgress({ locale }: { locale?: Locale }) {
  const [runs, setRuns] = useState<CrawlRun[]>([]);

  useEffect(() => {
    const fetchRuns = () => {
      fetch('/api/crawl-runs/latest?limit=20')
        .then(r => r.json())
        .then(data => setRuns(data.runs || []))
        .catch(() => {});
    };
    fetchRuns();
    const iv = setInterval(fetchRuns, 15000);
    return () => clearInterval(iv);
  }, []);

  const bySource: Record<string, CrawlRun> = {};
  for (const run of runs) {
    if (!bySource[run.source]) bySource[run.source] = run;
  }

  const sources = Object.entries(bySource);
  if (sources.length === 0) return null;

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono">{t('progress.latestRuns', locale)}</h3>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-px bg-[var(--color-border)]">
        {sources.map(([src, run]) => {
          const style = STATUS_STYLES[run.status] || STATUS_STYLES.running;
          return (
            <div key={src} className="bg-[var(--color-panel)] px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2 h-2 rounded-full ${style.dot} ${run.status === 'running' ? 'animate-pulse' : ''}`} />
                <span className="text-xs font-semibold capitalize text-[var(--color-text)]">{src.replace('_hiring', ' HN')}</span>
              </div>
              <div className="text-[11px] font-mono text-[var(--color-text-dim)]">
                <span className={style.text}>{t(`progress.${run.status}`, locale)}</span>
                {run.duration_ms != null && <span> · {formatDuration(run.duration_ms)}</span>}
                {run.jobs_inserted != null && run.jobs_inserted > 0 && <span> · +{run.jobs_inserted} new</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
