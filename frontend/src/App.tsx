import { useEffect, useState } from 'react';
import { SOURCES } from './lib/utils';

import { OverviewPage } from './components/OverviewPage';
import { PlatformPage } from './components/PlatformPage';

const PLATFORM_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'reed', label: 'Reed' },
  { key: 'jooble', label: 'Jooble' },
  { key: 'devitjobs', label: 'DevITJobs' },
  { key: 'hn_hiring', label: 'HN Hiring' },
  { key: 'remoteok', label: 'RemoteOK' },
] as const;

type TabKey = (typeof PLATFORM_TABS)[number]['key'];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const poll = () => {
      fetch('/api/health')
        .then(r => r.json())
        .then(setHealth)
        .catch(() => setHealth({ status: 'unhealthy' }));
    };
    poll();
    const iv = setInterval(poll, 30000);
    return () => clearInterval(iv);
  }, []);

  const isHealthy = health?.status === 'healthy';

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Top navbar ── */}
      <header className="bg-[var(--color-panel)] border-b border-[var(--color-border)] px-6 sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between h-12">
          <div className="flex items-center gap-6">
            {/* Logo */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-white">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                  <path d="M12 2L2 7l10 5 10-5-10-5zm0 10l-10 5 10 5 10-5-10-5z" />
                </svg>
              </div>
              <span className="text-sm font-semibold tracking-tight font-[var(--font-display)]">Job Scraper</span>
            </div>

            {/* Tabs */}
            <nav className="flex items-center gap-0.5 -mb-px">
              {PLATFORM_TABS.map(tab => {
                const isActive = activeTab === tab.key;
                const meta = tab.key !== 'overview' ? SOURCES[tab.key] : null;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`relative px-3 py-3.5 text-xs font-medium transition-colors ${
                      isActive
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text-dim)] hover:text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {meta && <span className={`w-2 h-2 rounded-full ${meta.bg} border ${isActive ? 'border-[var(--color-accent)]' : 'border-transparent'}`} />}
                      {tab.label}
                    </span>
                    {isActive && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-accent)] rounded-t" />
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Health */}
          <div className="flex items-center gap-2 text-xs font-mono text-[var(--color-text-dim)]">
            <span className={`w-2 h-2 rounded-full ${isHealthy ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
            {isHealthy
              ? `${Math.floor(Number(health!.uptimeSeconds) / 60)}m · ${health!.dbLatencyMs}ms`
              : 'OFFLINE'}
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className="flex-1 p-6 max-w-[1600px] mx-auto w-full">
        {activeTab === 'overview' ? (
          <OverviewPage />
        ) : (
          <PlatformPage key={activeTab} source={activeTab} />
        )}
      </main>
    </div>
  );
}
