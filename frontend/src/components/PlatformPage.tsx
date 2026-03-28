import { useState } from 'react';
import { Play, Filter, ShieldAlert } from 'lucide-react';
import { motion } from 'framer-motion';
import { JobsTable } from './JobsTable';
import { PlatformProgress } from './PlatformProgress';
import { ProgressBar } from './ProgressBar';
import { t, type Locale } from '../lib/i18n';
import { usePolling } from '../hooks/usePolling';
import { useProgress } from '../hooks/useProgress';

interface SourceCapability {
  name: string;
  displayName: string;
  supportsNativeTimeFilter: boolean;
  minTimeGranularityHours: number | null;
  supportedTimeOptions: string[];
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

const ALL_SCRAPE_TIME_OPTIONS = [
  { value: 'r86400', label: '24h' },
  { value: 'r604800', label: '1 week' },
  { value: 'r2592000', label: '1 month' },
];

const INGEST_FILTER_OPTIONS = [
  { value: '', labelKey: 'platform.all' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '1w', label: '1w' },
];

function AnimatedNumber({ value }: { value: number }) {
  return <span className="font-mono">{value.toLocaleString()}</span>;
}

export function PlatformPage({ source, locale }: { source: string; locale: Locale }) {
  const [capability, setCapability] = useState<SourceCapability | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [applyStats, setApplyStats] = useState<ApplyStats | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scrapeTimeFilter, setScrapeTimeFilter] = useState('r86400');
  const [ingestFilter, setIngestFilter] = useState('');
  const { progress, connected } = useProgress();

  usePolling(async (signal) => {
    try {
      const resp = await fetch('/api/sources', { signal });
      const data: { sources?: SourceCapability[] } | SourceCapability[] = await resp.json();
      const srcs = Array.isArray(data) ? data : data.sources ?? [];
      const cap = srcs.find(s => s.name === source);
      setCapability(cap ?? null);
    } catch {
      setCapability(null);
    }
  }, 30000, [source]);

  usePolling(async (signal) => {
    try {
      const [statsResp, applyResp] = await Promise.all([
        fetch(`/api/jobs/stats?source=${source}`, { signal }),
        fetch(`/api/apply-discovery/stats?source=${source}`, { signal }),
      ]);
      setStats(await statsResp.json());
      setApplyStats(await applyResp.json());
    } catch {
      // Keep old snapshot if one round fails.
    }
  }, 30000, [source]);

  const supportsTime = capability?.supportsNativeTimeFilter ?? false;
  const availableOptions = capability?.supportedTimeOptions ?? [];

  const handleTrigger = async (force = false) => {
    setDispatching(true);
    setDispatchMsg(null);
    setErrorMsg(null);
    try {
      const body: Record<string, unknown> = { force };
      if (supportsTime && availableOptions.includes(scrapeTimeFilter)) {
        body.timeFilter = scrapeTimeFilter;
      }
      const resp = await fetch(`/api/trigger/source/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await resp.json() as Record<string, unknown>;

      if (!resp.ok) {
        if (result.error === 'source_in_cooldown') {
          setDispatching(false);
          setErrorMsg(`${t('platform.cooldown', locale)} (${result.cooldownUntil})`);
          return;
        }
        if (result.error === 'source_busy') {
          setDispatching(false);
          setErrorMsg(`${t('platform.busy', locale)} (${result.currentHolder})`);
          return;
        }
        throw new Error((result.error as string) || `HTTP ${resp.status}`);
      }

      setDispatching(false);
      setDispatchMsg(`${t('common.queued', locale)} -> ${result.queue} (${result.jobId})`);
      setTimeout(() => setDispatchMsg(null), 6000);
    } catch (err: unknown) {
      setDispatching(false);
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const statItems = stats ? [
    { label: t('platform.total', locale), value: stats.total ?? 0 },
    { label: t('overview.last24h', locale), value: stats.last_24h ?? 0 },
    { label: t('overview.last1h', locale), value: stats.last_1h ?? 0 },
    { label: t('platform.sponsor', locale), value: stats.sponsor_jobs ?? 0 },
  ] : null;

  const loginCount = (applyStats?.byStatus.requires_login ?? 0)
    + (applyStats?.byStatus.oauth_google ?? 0)
    + (applyStats?.byStatus.oauth_linkedin ?? 0);

  const scopedProgress = progress && (progress.source === '' || progress.source === source)
    ? progress
    : null;

  return (
    <div className="space-y-5">
      {(source === 'jooble' || scopedProgress?.stage !== 'idle') && (
        <div className="space-y-2">
          <ProgressBar progress={scopedProgress} />
          {!connected && (
            <p className="text-[11px] font-mono text-[var(--color-text-dim)]">
              Reconnecting to live progress stream...
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="panel p-4">
          <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">{t('platform.dispatch', locale)}</h3>

          {supportsTime && availableOptions.length > 0 ? (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-accent)] font-mono font-semibold mb-1.5">
                <Filter className="w-3 h-3" /> {t('platform.timeWindow', locale)}
              </div>
              <div className="flex gap-1 flex-wrap">
                {ALL_SCRAPE_TIME_OPTIONS.filter(o => availableOptions.includes(o.value)).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setScrapeTimeFilter(opt.value)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-all ${
                      scrapeTimeFilter === opt.value
                        ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                        : 'bg-[var(--color-panel)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-accent)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[11px] font-mono text-[var(--color-text-dim)] mb-3">{t('platform.fullFetch', locale)}</p>
          )}

          <button
            onClick={() => handleTrigger(false)}
            disabled={dispatching}
            className="w-full flex justify-center items-center gap-2 py-2 px-3 rounded-lg bg-[var(--color-accent)] text-white font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-40"
          >
            {dispatching ? (
              <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            {dispatching ? t('platform.dispatching', locale) : t('platform.runNow', locale)}
          </button>

          {errorMsg && errorMsg.includes('cooldown') && (
            <button
              onClick={() => handleTrigger(true)}
              className="w-full mt-2 flex justify-center items-center gap-1.5 py-1.5 px-3 rounded-lg border border-[var(--color-warning)] text-[var(--color-warning)] text-xs font-medium hover:bg-[var(--color-warning-light)] transition-all"
            >
              <ShieldAlert className="w-3 h-3" />
              {t('platform.forceTrigger', locale)}
            </button>
          )}

          {dispatchMsg && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[11px] font-mono text-[var(--color-success)] mt-2 text-center">
              {dispatchMsg}
            </motion.p>
          )}
          {errorMsg && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[11px] font-mono text-[var(--color-danger)] mt-2 text-center">
              {errorMsg}
            </motion.p>
          )}
        </div>

        {statItems ? statItems.map((it, i) => (
          <motion.div
            key={it.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="panel p-4"
          >
            <div className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-dim)] font-mono mb-1">{it.label}</div>
            <div className="text-2xl font-semibold tracking-tight"><AnimatedNumber value={it.value} /></div>
          </motion.div>
        )) : (
          <>
            <div className="panel p-4 h-20 animate-pulse" />
            <div className="panel p-4 h-20 animate-pulse" />
            <div className="panel p-4 h-20 animate-pulse" />
          </>
        )}
      </div>

      {applyStats && applyStats.total > 0 && (
        <div className="panel p-4">
          <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">{t('apply.title', locale)}</h3>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div className="text-center">
              <div className="text-lg font-semibold text-[var(--color-success)]">{applyStats.byStatus.final_form_reached ?? 0}</div>
              <div className="text-[10px] font-mono text-[var(--color-text-dim)]">{t('apply.finalForm', locale)}</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-semibold">{applyStats.byStatus.platform_desc_only ?? 0}</div>
              <div className="text-[10px] font-mono text-[var(--color-text-dim)]">{t('apply.platformDesc', locale)}</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-semibold text-[var(--color-warning)]">{loginCount}</div>
              <div className="text-[10px] font-mono text-[var(--color-text-dim)]">{t('apply.needsLogin', locale)}</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-semibold text-[var(--color-danger)]">{applyStats.byStatus.blocked ?? 0}</div>
              <div className="text-[10px] font-mono text-[var(--color-text-dim)]">{t('apply.blocked', locale)}</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-semibold text-[var(--color-text-dim)]">{applyStats.byStatus.unresolved ?? 0}</div>
              <div className="text-[10px] font-mono text-[var(--color-text-dim)]">{t('apply.unresolved', locale)}</div>
            </div>
            {applyStats.coverage && (
              <div className="text-center">
                <div className="text-lg font-semibold text-[var(--color-text)]">{applyStats.coverage.resolvedRate.toFixed(1)}%</div>
                <div className="text-[10px] font-mono text-[var(--color-text-dim)]">{t('overview.coverage', locale)}</div>
              </div>
            )}
          </div>
          {applyStats.coverage && (
            <div className="mt-3 text-[11px] font-mono text-[var(--color-text-dim)]">
              {t('overview.unresolvedJobs', locale)}: <span className="text-[var(--color-warning)]">{applyStats.coverage.unresolvedJobs}</span> / {applyStats.coverage.totalJobs}
            </div>
          )}
        </div>
      )}

      <PlatformProgress source={source} locale={locale} />

      <div>
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--color-text-dim)] font-mono">{t('platform.ingested', locale)}</span>
          {INGEST_FILTER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setIngestFilter(opt.value)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-all ${
                ingestFilter === opt.value ? 'pill-active' : 'pill-inactive'
              }`}
            >
              {opt.labelKey ? t(opt.labelKey, locale) : opt.label}
            </button>
          ))}
        </div>
        <JobsTable key={`${source}:${ingestFilter || 'all'}`} activeTab={source} ingestFilter={ingestFilter} locale={locale} />
      </div>
    </div>
  );
}
