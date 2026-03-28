import { useEffect, useState } from 'react';
import { Play, Filter } from 'lucide-react';
import { motion } from 'framer-motion';
import { JobsTable } from './JobsTable';
import { PlatformProgress } from './PlatformProgress';

interface SourceCapability {
  name: string;
  displayName: string;
  supportsNativeTimeFilter: boolean;
  minTimeGranularityHours: number | null;
  supportedTimeOptions: string[];
}

const ALL_SCRAPE_TIME_OPTIONS = [
  { value: 'r86400',   label: '24h' },
  { value: 'r604800',  label: '1 week' },
  { value: 'r2592000', label: '1 month' },
];

const INGEST_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '1w', label: '1w' },
];

function AnimatedNumber({ value }: { value: number }) {
  return <span className="font-mono">{value.toLocaleString()}</span>;
}

export function PlatformPage({ source }: { source: string }) {
  const [capability, setCapability] = useState<SourceCapability | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scrapeTimeFilter, setScrapeTimeFilter] = useState('r86400');
  const [ingestFilter, setIngestFilter] = useState('');

  useEffect(() => {
    fetch('/api/sources')
      .then(r => r.json())
      .then((data: { sources: SourceCapability[] }) => {
        const srcs = Array.isArray(data) ? data : data.sources ?? [];
        const cap = srcs.find(s => s.name === source);
        setCapability(cap ?? null);
      })
      .catch(() => {});
  }, [source]);

  useEffect(() => {
    const fetchStats = () => {
      fetch(`/api/jobs/stats?source=${source}`)
        .then(r => r.json())
        .then(setStats)
        .catch(() => {});
    };
    fetchStats();
    const iv = setInterval(fetchStats, 30000);
    return () => clearInterval(iv);
  }, [source]);

  const supportsTime = capability?.supportsNativeTimeFilter ?? false;
  const availableOptions = capability?.supportedTimeOptions ?? [];

  const handleTrigger = async () => {
    setDispatching(true);
    setDispatchMsg(null);
    setErrorMsg(null);
    try {
      const body: Record<string, unknown> = {};
      if (supportsTime && availableOptions.includes(scrapeTimeFilter)) {
        body.timeFilter = scrapeTimeFilter;
      }
      const resp = await fetch(`/api/trigger/source/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error((d as Record<string, string>).error || `HTTP ${resp.status}`);
      }
      const result = await resp.json() as { queue: string; jobId: string };
      setDispatching(false);
      setDispatchMsg(`Queued → ${result.queue} (${result.jobId})`);
      setTimeout(() => setDispatchMsg(null), 6000);
    } catch (err: unknown) {
      setDispatching(false);
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const statItems = stats ? [
    { label: 'Total', value: stats.total ?? 0 },
    { label: 'Last 24h', value: stats.last_24h ?? 0 },
    { label: 'Last 1h', value: stats.last_1h ?? 0 },
    { label: 'Sponsor', value: stats.sponsor_jobs ?? 0 },
  ] : null;

  return (
    <div className="space-y-5">
      {/* Controls + stats row */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Trigger card */}
        <div className="panel p-4">
          <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-3">Dispatch</h3>

          {supportsTime && availableOptions.length > 0 ? (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-accent)] font-mono font-semibold mb-1.5">
                <Filter className="w-3 h-3" /> Time Window
              </div>
              <div className="flex gap-1 flex-wrap">
                {ALL_SCRAPE_TIME_OPTIONS.filter(o => availableOptions.includes(o.value)).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setScrapeTimeFilter(opt.value)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-all ${
                      scrapeTimeFilter === opt.value
                        ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                        : 'bg-white text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-accent)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[11px] font-mono text-[var(--color-text-dim)] mb-3">Full fetch — no native time filter</p>
          )}

          <button
            onClick={handleTrigger}
            disabled={dispatching}
            className="w-full flex justify-center items-center gap-2 py-2 px-3 rounded-lg bg-[var(--color-accent)] text-white font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-40"
          >
            {dispatching ? (
              <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            {dispatching ? 'Dispatching…' : 'Run Now'}
          </button>

          {dispatchMsg && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[11px] font-mono text-[var(--color-success)] mt-2 text-center">
              ✓ {dispatchMsg}
            </motion.p>
          )}
          {errorMsg && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[11px] font-mono text-[var(--color-danger)] mt-2 text-center">
              ✗ {errorMsg}
            </motion.p>
          )}
        </div>

        {/* Stats cards */}
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

      {/* Progress / recent runs */}
      <PlatformProgress source={source} />

      {/* Ingest filter + Jobs table */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--color-text-dim)] font-mono">Ingested</span>
          {INGEST_FILTER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setIngestFilter(opt.value)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-all ${
                ingestFilter === opt.value ? 'pill-active' : 'pill-inactive'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <JobsTable activeTab={source} ingestFilter={ingestFilter} />
      </div>
    </div>
  );
}
