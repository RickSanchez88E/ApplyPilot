import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const ALL_SOURCES = ['linkedin', 'devitjobs', 'reed', 'jooble', 'hn_hiring', 'remoteok'];

export function SourceFilters({ activeTab, setActiveTab }: { activeTab: string | null, setActiveTab: (s: string | null) => void }) {
  const [sources, setSources] = useState<{source: string, count: number, today: number}[]>(
    ALL_SOURCES.map(s => ({ source: s, count: 0, today: 0 }))
  );
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const fetchStats = () => {
      fetch('/api/jobs/stats')
        .then(res => res.json())
        .then(data => {
          const apiSources: {source: string, count: number, today: number}[] = data.bySource || [];
          const merged = ALL_SOURCES.map(name => {
            const found = apiSources.find(s => s.source === name);
            return found || { source: name, count: 0, today: 0 };
          });
          merged.sort((a, b) => b.count - a.count);
          setSources(merged);
          setTotal(data.total || 0);
        });
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const maxCount = Math.max(...sources.map(s => s.count), 1);

  return (
    <div className="panel p-5 flex flex-col">
      <h2 className="text-xs uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono mb-4">Volume Distribution</h2>
      
      <div className="space-y-2 flex-1">
        <button 
          onClick={() => setActiveTab(null)}
          className={`w-full text-left p-3 rounded-lg border transition-all ${
            activeTab === null 
              ? 'bg-[var(--color-accent-light)] border-[var(--color-accent)]/30' 
              : 'border-transparent hover:bg-[var(--color-surface)]'
          }`}
        >
          <div className="flex justify-between items-center text-sm font-medium">
            <span className="text-[var(--color-text)]">All Sources</span>
            <span className="font-mono text-[var(--color-accent)] font-semibold">{total}</span>
          </div>
        </button>

        <AnimatePresence>
          {sources.map((src, i) => {
            const pct = Math.max((src.count / maxCount) * 100, 2);
            const isActive = activeTab === src.source;

            return (
              <motion.button
                key={src.source}
                layout
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                onClick={() => setActiveTab(isActive ? null : src.source)}
                className={`w-full text-left p-3 rounded-lg border transition-all ${
                  isActive 
                    ? 'bg-[var(--color-accent-light)] border-[var(--color-accent)]/30' 
                    : 'border-transparent hover:bg-[var(--color-surface)]'
                }`}
              >
                <div className="flex justify-between items-center text-sm font-medium mb-1.5">
                  <span className="capitalize text-[var(--color-text)]">{src.source.replace('_hiring', '')}</span>
                  <div className="flex items-center gap-2">
                    {src.today > 0 && <span className="text-[10px] text-[var(--color-success)] bg-[var(--color-success-light)] px-1.5 py-0.5 rounded font-mono font-semibold">+{src.today}</span>}
                    <span className={`font-mono text-xs ${src.count === 0 ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text-secondary)]'}`}>{src.count}</span>
                  </div>
                </div>
                <div className="h-1 w-full bg-[var(--color-surface)] rounded-full overflow-hidden">
                  {src.count > 0 ? (
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className="h-full bg-[var(--color-accent)] rounded-full"
                    />
                  ) : (
                    <div className="h-full w-full" />
                  )}
                </div>
              </motion.button>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
