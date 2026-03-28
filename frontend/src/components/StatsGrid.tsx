import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

function AnimatedNumber({ value }: { value: number }) {
  return <span className="font-mono text-[var(--color-text)]">{value.toLocaleString()}</span>;
}

export function StatsGrid({ activeTab }: { activeTab: string | null }) {
  const [stats, setStats] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    const fetchStats = () => {
      let url = '/api/jobs/stats';
      if (activeTab) url += `?source=${activeTab}`;
      fetch(url).then(res => res.json()).then(setStats);
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, [activeTab]);

  if (!stats) return <div className="h-20 panel animate-pulse" />;

  const items = [
    { label: 'Total Jobs', value: stats.total || 0 },
    { label: 'Ingested (1h)', value: stats.last_1h || 0 },
    { label: 'Sponsorship', value: stats.sponsor_jobs || 0 },
    { label: 'Pending AI', value: stats.pending || 0 },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {items.map((it, i) => (
        <motion.div
          key={it.label}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.08 }}
          className="panel p-4 flex flex-col justify-between"
        >
          <h3 className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-text-dim)] font-mono mb-1.5">{it.label}</h3>
          <div className="text-2xl font-semibold tracking-tight">
            <AnimatedNumber value={it.value} />
          </div>
        </motion.div>
      ))}
    </div>
  );
}
