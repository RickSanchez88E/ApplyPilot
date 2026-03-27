import { useEffect, useState } from 'react';
import { Play, Activity, Filter, Database } from 'lucide-react';
import { motion } from 'framer-motion';

import { StatsGrid } from './components/StatsGrid';
import { JobsTable } from './components/JobsTable';
import { SourceFilters } from './components/SourceFilters';
import { ProgressBar } from './components/ProgressBar';
import { KeywordConfig } from './components/KeywordConfig';
import { useProgress } from './hooks/useProgress';

/**
 * REV-6: These pills filter by DB ingestion time (created_at).
 * They are SECONDARY filters, clearly labeled "DB Ingested".
 * They do NOT represent job posting dates.
 */
const INGEST_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '1w', label: '1w' },
  { value: '1m', label: '1m' },
];

/**
 * Scrape time options — only shown when ALL selected sources support native time filtering.
 * 1h is intentionally excluded (Reed/Jooble minimum granularity = 1 day).
 */
const ALL_SCRAPE_TIME_OPTIONS = [
  { value: 'r86400',   label: '24h' },
  { value: 'r604800',  label: '1 week' },
  { value: 'r2592000', label: '1 month' },
];

/** Sources in multi-source orchestrator (LinkedIn excluded — uses /api/trigger) */
const MULTI_SOURCES = ['devitjobs', 'reed', 'jooble', 'hn_hiring', 'remoteok'] as const;

interface SourceCapability {
  name: string;
  displayName: string;
  supportsNativeTimeFilter: boolean;
  minTimeGranularityHours: number | null;
  supportedTimeOptions: string[];
}

export default function App() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [ingestFilter, setIngestFilter] = useState('');
  const { progress } = useProgress();

  useEffect(() => {
    const pollHealth = () => {
        fetch('/api/health')
            .then(res => res.json())
            .then(data => setHealth(data))
            .catch(() => setHealth({ status: 'unhealthy' }));
    };
    pollHealth();
    const interval = setInterval(pollHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const isHealthy = health?.status === 'healthy';

  return (
    <div className="min-h-screen p-6 max-w-[1600px] mx-auto space-y-6">
      
      {/* ── HEADER ── */}
      <header className="flex items-center justify-between pb-6 mb-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
              <path d="M12 2L2 7l10 5 10-5-10-5zm0 10l-10 5 10 5 10-5-10-5z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight m-0" style={{ fontFamily: 'var(--font-display)' }}>Job Scraper</h1>
            <p className="text-[11px] text-[var(--color-text-dim)] uppercase tracking-widest font-mono">Data Workbench</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
           {/* REV-6: DB ingestion filter — clearly secondary, labeled "DB Ingested" */}
           <div className="flex items-center gap-1.5">
             <div className="flex items-center gap-1 text-[var(--color-text-dim)] mr-1">
               <Database className="w-3 h-3" />
               <span className="text-[10px] uppercase tracking-wider font-semibold">Ingested</span>
             </div>
             {INGEST_FILTER_OPTIONS.map(opt => (
               <button
                 key={opt.value}
                 onClick={() => setIngestFilter(opt.value)}
                 className={`px-2 py-0.5 rounded text-xs font-mono transition-all ${
                   ingestFilter === opt.value
                     ? 'pill-active'
                     : 'pill-inactive'
                 }`}
               >
                 {opt.label}
               </button>
             ))}
           </div>

           {/* Health indicator */}
           {health && (
             <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]">
               <span className={`w-2 h-2 rounded-full ${isHealthy ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
               <span>
                 {isHealthy
                   ? `${Math.floor(Number(health.uptimeSeconds) / 60)}m · ${health.dbLatencyMs}ms`
                   : 'OFFLINE'}
               </span>
             </div>
           )}
        </div>
      </header>

      {/* ── GRID LAYOUT ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* SIDEBAR */}
        <div className="lg:col-span-1 space-y-5">
           <ScrapeControls sources={sources} setSources={setSources} isScraping={!!health?.isScraping} />
           <KeywordConfig />
           <SourceFilters activeTab={activeTab} setActiveTab={setActiveTab} />
        </div>

        {/* MAIN DISPLAY */}
        <div className="lg:col-span-3 space-y-5">
           <StatsGrid activeTab={activeTab} />
            <ProgressBar progress={progress} />
            <JobsTable activeTab={activeTab} ingestFilter={ingestFilter} />
        </div>
        
      </div>
    </div>
  )
}

interface ScrapeControlsProps {
  sources: string[];
  setSources: (s: string[]) => void;
  isScraping: boolean;
}

function ScrapeControls({ sources, setSources, isScraping }: ScrapeControlsProps) {
   const [localLoading, setLocalLoading] = useState(false);
   const [statusMsg, setStatusMsg] = useState<string | null>(null);
   const [errorMsg, setErrorMsg] = useState<string | null>(null);
   const [scrapeTimeFilter, setScrapeTimeFilter] = useState('r86400');
   const [capabilities, setCapabilities] = useState<SourceCapability[]>([]);

   const busy = isScraping || localLoading;

   useEffect(() => {
     fetch('/api/sources')
       .then(res => res.json())
       .then((data: { sources: SourceCapability[] }) => {
         setCapabilities(Array.isArray(data) ? data : data.sources ?? []);
       })
       .catch(() => {});
   }, []);

   /**
    * REV-3: Intersection of supportedTimeOptions across all selected sources.
    * If ANY selected source lacks native time filter → empty → no time controls.
    */
   const computeTimeIntersection = (): string[] => {
     if (sources.length === 0) return [];
     const selectedCaps = sources
       .map(s => capabilities.find(c => c.name === s))
       .filter((c): c is SourceCapability => !!c);
     if (selectedCaps.length === 0) return [];
     if (selectedCaps.some(c => !c.supportsNativeTimeFilter)) return [];
     let intersection = selectedCaps[0].supportedTimeOptions;
     for (let i = 1; i < selectedCaps.length; i++) {
       const options = new Set(selectedCaps[i].supportedTimeOptions);
       intersection = intersection.filter(opt => options.has(opt));
     }
     return intersection;
   };

   const availableTimeOptions = computeTimeIntersection();
   const showTimeControls = availableTimeOptions.length > 0;

   useEffect(() => {
     if (!showTimeControls || !availableTimeOptions.includes(scrapeTimeFilter)) {
       setScrapeTimeFilter('r86400');
     }
   }, [sources, capabilities]);

   const handleTrigger = async () => {
     if (sources.length === 0) return alert('Select sources first');
     setLocalLoading(true);
     setStatusMsg(`Dispatching ${sources.length} source(s)…`);
     setErrorMsg(null);

     try {
       const body: Record<string, unknown> = { sources };
       if (showTimeControls) {
         body.timeFilter = scrapeTimeFilter;
       }

       const resp = await fetch('/api/trigger/multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
       });
       if (!resp.ok) {
         const data = await resp.json().catch(() => ({}));
         throw new Error((data as Record<string, string>).error || `HTTP ${resp.status}`);
       }
       setStatusMsg('Engine running — scraping in background…');
       const poll = setInterval(async () => {
         try {
           const h = await fetch('/api/health').then(r => r.json());
           if (!h.isScraping) {
             clearInterval(poll);
             setLocalLoading(false);
             setStatusMsg('✓ Scrape complete');
             setTimeout(() => setStatusMsg(null), 4000);
           }
         } catch { /* ignore */ }
       }, 3000);
     } catch (err: unknown) {
       setLocalLoading(false);
       setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
       setStatusMsg(null);
     }
   };

   const handleSelectAll = () => setSources([...MULTI_SOURCES]);
   const handleSelectNone = () => setSources([]);

   return (
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-4">
           <h2 className="text-xs uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono">Operations</h2>
           <Activity className="w-4 h-4 text-[var(--color-accent)]" />
        </div>

        <div className="space-y-3">
           <div className="flex gap-2 mb-2">
             <button onClick={handleSelectAll} className="text-xs text-[var(--color-accent)] hover:underline font-mono">Select All</button>
             <span className="text-[var(--color-border-strong)]">|</span>
             <button onClick={handleSelectNone} className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] font-mono">None</button>
           </div>
           <div className="grid grid-cols-2 gap-2 mb-3">
             {MULTI_SOURCES.map(src => (
               <label key={src} className="flex items-center gap-2 cursor-pointer text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors">
                 <input 
                   type="checkbox" 
                   checked={sources.includes(src)}
                   onChange={(e) => {
                     if (e.target.checked) setSources([...sources, src]);
                     else setSources(sources.filter((s: string) => s !== src));
                   }}
                   className="rounded border-[var(--color-border-strong)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                 />
                 <span className="capitalize">{src.replace('_hiring', '')}</span>
               </label>
             ))}
           </div>

           {/* Scrape time window — only when ALL selected support native time filter */}
           {showTimeControls && (
             <div className="mb-2 p-3 rounded-lg bg-[var(--color-accent-light)] border border-[var(--color-accent)]/20">
               <div className="flex items-center gap-1.5 text-xs text-[var(--color-accent)] font-mono font-semibold mb-2">
                 <Filter className="w-3 h-3" />
                 Crawl Time Window
               </div>
               <div className="flex gap-1 flex-wrap">
                 {ALL_SCRAPE_TIME_OPTIONS
                   .filter(opt => availableTimeOptions.includes(opt.value))
                   .map(opt => (
                     <button
                       key={opt.value}
                       onClick={() => setScrapeTimeFilter(opt.value)}
                       className={`px-2.5 py-1 rounded text-xs font-mono transition-all border ${
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
           )}

           {sources.length > 0 && !showTimeControls && (
             <div className="mb-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
               <p className="text-[11px] text-[var(--color-text-dim)] font-mono">
                 Full fetch mode — selected sources have no time-constrained API.
               </p>
             </div>
           )}
           
           <button 
             onClick={handleTrigger}
             disabled={busy || sources.length === 0}
             className="w-full flex justify-center items-center gap-2 py-2.5 px-4 rounded-lg bg-[var(--color-accent)] text-white font-semibold text-sm shadow-sm hover:opacity-90 transition-all disabled:opacity-40"
           >
             {busy ? (
               <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
             ) : (
               <Play className="w-4 h-4 fill-current" />
             )}
             {busy ? 'Running…' : 'Dispatch'}
           </button>

           {statusMsg && (
             <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs font-mono text-[var(--color-success)] mt-1 text-center">
               {statusMsg}
             </motion.p>
           )}
           {errorMsg && (
             <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs font-mono text-[var(--color-danger)] mt-1 text-center">
               ✗ {errorMsg}
             </motion.p>
           )}
        </div>
      </div>
   );
}
