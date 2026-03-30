import { useState, useCallback } from 'react';
import { SOURCES } from './lib/utils';
import { t, getLocale, setLocale, type Locale } from './lib/i18n';
import { usePolling } from './hooks/usePolling';

import { OverviewPage } from './components/OverviewPage';
import { PlatformPage } from './components/PlatformPage';
import { ApplyDiscoveryPage } from './components/ApplyDiscoveryPage';

const PLATFORM_TABS = [
  { key: 'overview', labelKey: 'nav.overview', label: 'Overview' },
  { key: 'apply_discovery', label: 'Apply Discovery' },
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
  const [locale, setLocaleState] = useState<Locale>(getLocale());

  const toggleLocale = useCallback(() => {
    const next = locale === 'en' ? 'zh' : 'en';
    setLocale(next);
    setLocaleState(next);
  }, [locale]);

  usePolling(async (signal) => {
    try {
      const resp = await fetch('/api/health', { signal });
      setHealth(await resp.json());
    } catch {
      setHealth({ status: 'unhealthy' });
    }
  }, 30000, []);

  const isHealthy = health?.status === 'healthy';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-[var(--color-panel)] border-b border-[var(--color-border)] px-3 md:px-6 sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto flex flex-col gap-2 py-2 md:py-0 md:h-12 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-white">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                  <path d="M12 2L2 7l10 5 10-5-10-5zm0 10l-10 5 10 5 10-5-10-5z" />
                </svg>
              </div>
              <span className="text-sm font-semibold tracking-tight font-[var(--font-display)]">{t('nav.title', locale)}</span>
            </div>

            <nav className="flex items-center gap-0.5 -mb-px overflow-x-auto whitespace-nowrap pb-0.5">
              {PLATFORM_TABS.map(tab => {
                const isActive = activeTab === tab.key;
                const meta = tab.key !== 'overview' ? SOURCES[tab.key] : null;
                const label = tab.key === 'overview' ? t('nav.overview', locale) : tab.label;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`relative px-3 py-3.5 text-xs font-medium transition-colors ${
                      isActive
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text-dim)] hover:text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {meta && <span className={`w-2 h-2 rounded-full ${meta.bg} border ${isActive ? 'border-[var(--color-accent)]' : 'border-transparent'}`} />}
                      {label}
                    </span>
                    {isActive && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-accent)] rounded-t" />
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-xs font-mono text-[var(--color-text-dim)] self-end md:self-auto">
            <button
              onClick={toggleLocale}
              className="px-2 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
              title={t('common.language', locale)}
              aria-label={t('common.switchLanguage', locale)}
            >
              {locale === 'en' ? '中文' : 'EN'}
            </button>
            <span className={`w-2 h-2 rounded-full ${isHealthy ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
            <span className="sr-only">
              {isHealthy ? t('common.systemHealthy', locale) : t('common.systemOffline', locale)}
            </span>
            {isHealthy
              ? `${Math.floor(Number(health!.uptimeSeconds) / 60)}m · ${health!.dbLatencyMs}ms`
              : t('nav.offline', locale)}
          </div>
        </div>
      </header>

      <main className="flex-1 p-3 md:p-6 max-w-[1600px] mx-auto w-full">
        {activeTab === 'overview' ? (
          <OverviewPage locale={locale} />
        ) : activeTab === 'apply_discovery' ? (
          <ApplyDiscoveryPage />
        ) : (
          <PlatformPage key={activeTab} source={activeTab} locale={locale} />
        )}
      </main>
    </div>
  );
}
