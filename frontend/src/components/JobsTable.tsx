import { useEffect, useMemo, useState } from 'react';
import { formatAgo, SOURCES } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';
import { t, type Locale } from '../lib/i18n';

const PAGE_SIZE = 50;

interface JobsResponse {
  jobs?: Record<string, unknown>[];
  pagination?: { totalCount?: number };
}

export function JobsTable({ activeTab, ingestFilter, locale }: { activeTab: string | null; ingestFilter: string; locale: Locale }) {
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const queryUrl = useMemo(() => {
    const offset = (currentPage - 1) * PAGE_SIZE;
    let url = `/api/jobs?limit=${PAGE_SIZE}&offset=${offset}&sortBy=posted_date&order=DESC`;
    if (activeTab) url += `&source=${activeTab}`;
    if (ingestFilter) url += `&timeRange=${ingestFilter}`;
    return url;
  }, [activeTab, ingestFilter, currentPage]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const fetchPage = async () => {
      try {
        const res = await fetch(queryUrl, { signal: controller.signal });
        const data: JobsResponse = await res.json();
        if (disposed) return;
        setJobs(data.jobs || []);
        setTotalCount(data.pagination?.totalCount ?? 0);
      } catch {
        if (!disposed) {
          setJobs([]);
          setTotalCount(0);
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void fetchPage();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [queryUrl]);

  const goToPage = (p: number) => {
    if (p >= 1 && p <= totalPages && p !== currentPage) {
      setLoading(true);
      setCurrentPage(p);
    }
  };

  const getPageNumbers = (): (number | '...')[] => {
    const pages: (number | '...')[] = [];
    const delta = 2;
    const left = Math.max(1, currentPage - delta);
    const right = Math.min(totalPages, currentPage + delta);

    if (left > 1) {
      pages.push(1);
      if (left > 2) pages.push('...');
    }
    for (let i = left; i <= right; i++) pages.push(i);
    if (right < totalPages) {
      if (right < totalPages - 1) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  const start = totalCount > 0 ? ((currentPage - 1) * PAGE_SIZE + 1) : 0;
  const end = Math.min(currentPage * PAGE_SIZE, totalCount);

  return (
    <div className="panel overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono flex items-center gap-2">
          {t('jobs.latest', locale)}
          {loading && <div className="w-3 h-3 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />}
        </h2>
        <span className="text-xs font-mono text-[var(--color-text-dim)]">
          {totalCount > 0 ? `${start}-${end} / ${totalCount}` : t('jobs.resultsZero', locale)}
        </span>
      </div>

      <div className="overflow-auto flex-1 max-h-[600px]">
        <table className="w-full text-left text-sm border-collapse table-fixed">
          <thead className="sticky top-0 bg-[var(--color-surface)] z-10 text-xs uppercase tracking-wider text-[var(--color-text-dim)] font-mono border-b border-[var(--color-border)]">
            <tr>
              <th className="px-3 py-2.5 font-medium w-[84px]">{t('jobs.source', locale)}</th>
              <th className="px-3 py-2.5 font-medium">{t('jobs.position', locale)}</th>
              <th className="px-3 py-2.5 font-medium w-[180px] hidden lg:table-cell">{t('jobs.company', locale)}</th>
              <th className="px-3 py-2.5 font-medium w-[140px] hidden md:table-cell">{t('jobs.location', locale)}</th>
              <th className="px-3 py-2.5 font-medium w-[110px]">{t('jobs.posted', locale)}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            <AnimatePresence>
              {jobs.map((job, i) => {
                const source = String(job.source || '');
                const srcMeta = SOURCES[source] || SOURCES.linkedin;
                const isUnverified = !srcMeta.linkReliable;
                const linkUrl = String(job.apply_url || job.source_url || job.linkedin_url || '#');
                const company = String(job.company_name || '—');
                const location = String(job.location || t('jobs.remote', locale));

                return (
                  <motion.tr
                    key={`${job.id}-${source}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: (i % PAGE_SIZE) * 0.01 }}
                    className="table-row-hover group"
                  >
                    <td className="px-3 py-2.5 align-top">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-medium ${srcMeta.bg} ${srcMeta.text}`}>
                        {srcMeta.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 min-w-0 align-top">
                      <div className="flex items-center gap-1 min-w-0">
                        <a
                          href={linkUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-[var(--color-text)] hover:text-[var(--color-accent)] transition-colors truncate"
                          title={String(job.job_title || '')}
                        >
                          {String(job.job_title || '—')}
                        </a>
                        {isUnverified ? (
                          <span title={t('jobs.cloudflareWarning', locale)}>
                            <AlertTriangle className="w-3 h-3 text-[var(--color-warning)] flex-shrink-0" />
                          </span>
                        ) : (
                          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 text-[var(--color-accent)] transition-opacity flex-shrink-0" />
                        )}
                      </div>
                      {(job.salary_text || job.can_sponsor) ? (
                        <div className="text-[11px] mt-0.5 text-[var(--color-text-dim)] font-mono flex gap-2 truncate">
                          {!!job.can_sponsor && <span className="text-[var(--color-success)]">★ {t('jobs.sponsor', locale)}</span>}
                          {!!job.salary_text && <span className="truncate">{String(job.salary_text)}</span>}
                        </div>
                      ) : null}
                      <div className="text-[11px] mt-0.5 text-[var(--color-text-dim)] lg:hidden">
                        <span className="truncate inline-block max-w-full">{company}</span>
                        <span className="mx-1">·</span>
                        <span className="truncate inline-block max-w-full">{location}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-text-secondary)] truncate hidden lg:table-cell" title={company}>
                      {company}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-text-dim)] text-xs truncate hidden md:table-cell" title={location}>
                      {location}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--color-text-dim)] font-mono align-top">
                      {job.posted_date ? formatAgo(String(job.posted_date), job.posted_date_precision as string | null) : '—'}
                    </td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface)]">
          <div className="text-xs text-[var(--color-text-dim)] font-mono">
            {t('jobs.pageOf', locale)} {currentPage} {t('jobs.of', locale)} {totalPages}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className="page-btn font-mono"
              aria-label={t('jobs.prevPage', locale)}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            {getPageNumbers().map((p, i) =>
              p === '...' ? (
                <span key={`dots-${i}`} className="px-1 text-[var(--color-text-dim)]">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => goToPage(p)}
                  className={`page-btn font-mono ${currentPage === p ? 'page-btn-active' : ''}`}
                >
                  {p}
                </button>
              ),
            )}
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="page-btn font-mono"
              aria-label={t('jobs.nextPage', locale)}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
