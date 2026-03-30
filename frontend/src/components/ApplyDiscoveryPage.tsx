import { useState, useEffect, useCallback } from 'react';

interface FinalFormResult {
  job_key: string;
  source: string;
  company: string;
  title: string;
  location: string | null;
  status: string;
  initial_apply_url: string | null;
  resolved_apply_url: string | null;
  final_form_url: string | null;
  form_provider: string | null;
  resolver_version: string;
  field_count: number | null;
  login_required: boolean;
  registration_required: boolean;
  last_resolution_error: string | null;
  updated_at: string;
}

interface DomainStat {
  domain: string;
  cnt: number;
}

interface ApplyDiscoveryStats {
  total: number;
  byStatus: Record<string, number>;
  coverage: {
    resolvedJobs: number;
    unresolvedJobs: number;
    totalJobs: number;
    resolvedRate: number;
  };
}

const STATUS_OPTIONS = [
  { value: 'final_form_reached', label: 'Final Form ✅', color: '#16a34a' },
  { value: 'platform_desc_only', label: 'Description Only', color: '#ca8a04' },
  { value: 'requires_login', label: 'Login Required', color: '#dc2626' },
  { value: 'blocked', label: 'Blocked', color: '#9333ea' },
  { value: 'failed', label: 'Failed', color: '#6b7280' },
];

const SOURCE_OPTIONS = ['all', 'hn_hiring', 'reed', 'devitjobs', 'remoteok', 'linkedin', 'jooble'];

export function ApplyDiscoveryPage() {
  const [results, setResults] = useState<FinalFormResult[]>([]);
  const [domains, setDomains] = useState<DomainStat[]>([]);
  const [stats, setStats] = useState<ApplyDiscoveryStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('final_form_reached');
  const [page, setPage] = useState(0);
  const LIMIT = 50;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status,
        limit: String(LIMIT),
        offset: String(page * LIMIT),
      });
      if (source !== 'all') params.set('source', source);

      const [formsRes, statsRes] = await Promise.all([
        fetch(`/api/apply-discovery/final-forms?${params}`),
        fetch(`/api/apply-discovery/stats${source !== 'all' ? `?source=${source}` : ''}`),
      ]);

      const formsData = await formsRes.json();
      const statsData = await statsRes.json();

      setResults(formsData.results ?? []);
      setDomains(formsData.domains ?? []);
      setTotal(formsData.total ?? 0);
      setStats(statsData);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [source, status, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalPages = Math.ceil(total / LIMIT);
  const finalFormCount = stats?.byStatus?.final_form_reached ?? 0;
  const totalJobs = stats?.coverage?.totalJobs ?? 0;
  const finalPct = totalJobs > 0 ? ((finalFormCount / totalJobs) * 100).toFixed(1) : '0';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Stats bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '10px',
        background: 'var(--color-panel)',
        padding: '12px 16px',
        borderRadius: '6px',
        border: '1px solid var(--color-border)',
      }}>
        {stats && Object.entries(stats.byStatus).map(([s, cnt]) => {
          const opt = STATUS_OPTIONS.find(o => o.value === s);
          return (
            <div key={s} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{
                fontSize: '11px',
                color: 'var(--color-text-dim)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>{opt?.label ?? s}</span>
              <span style={{
                fontSize: '20px',
                fontWeight: 600,
                color: opt?.color ?? 'var(--color-text-primary)',
                fontVariantNumeric: 'tabular-nums',
              }}>{cnt}</span>
            </div>
          );
        })}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontSize: '11px', color: 'var(--color-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Final Form Rate
          </span>
          <span style={{
            fontSize: '20px',
            fontWeight: 600,
            color: Number(finalPct) >= 10 ? '#16a34a' : '#dc2626',
            fontVariantNumeric: 'tabular-nums',
          }}>{finalPct}%</span>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        flexWrap: 'wrap',
        background: 'var(--color-panel)',
        padding: '8px 12px',
        borderRadius: '6px',
        border: '1px solid var(--color-border)',
      }}>
        <span style={{ fontSize: '12px', color: 'var(--color-text-dim)', fontWeight: 500 }}>Source:</span>
        {SOURCE_OPTIONS.map(s => (
          <button
            key={s}
            onClick={() => { setSource(s); setPage(0); }}
            style={{
              padding: '3px 10px',
              fontSize: '12px',
              borderRadius: '4px',
              border: `1px solid ${source === s ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: source === s ? 'var(--color-accent)' : 'transparent',
              color: source === s ? '#fff' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontWeight: source === s ? 600 : 400,
            }}
          >{s === 'all' ? 'All' : s}</button>
        ))}

        <span style={{ marginLeft: '16px', fontSize: '12px', color: 'var(--color-text-dim)', fontWeight: 500 }}>Status:</span>
        <select
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(0); }}
          style={{
            padding: '3px 8px',
            fontSize: '12px',
            borderRadius: '4px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg)',
            color: 'var(--color-text-primary)',
          }}
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--color-text-dim)' }}>
          {total} results
        </span>
      </div>

      {/* Domain distribution (sidebar-like) */}
      {status === 'final_form_reached' && domains.length > 0 && (
        <div style={{
          background: 'var(--color-panel)',
          padding: '10px 14px',
          borderRadius: '6px',
          border: '1px solid var(--color-border)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-dim)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Domain Distribution
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {domains.map(d => (
              <span key={d.domain} style={{
                padding: '2px 8px',
                fontSize: '11px',
                background: '#f3f4f6',
                borderRadius: '3px',
                color: '#374151',
                fontFamily: 'var(--font-mono)',
              }}>
                {d.domain} <b>{d.cnt}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Results table */}
      <div style={{
        background: 'var(--color-panel)',
        borderRadius: '6px',
        border: '1px solid var(--color-border)',
        overflow: 'auto',
      }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-text-dim)' }}>Loading...</div>
        ) : results.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-text-dim)' }}>No results</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)', background: '#f9fafb' }}>
                <th style={thStyle}>#</th>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Company</th>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>Provider</th>
                <th style={thStyle}>Fields</th>
                <th style={thStyle}>Form URL</th>
                <th style={thStyle}>Resolver</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={r.job_key} style={{
                  borderBottom: '1px solid var(--color-border)',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={tdStyle}>{page * LIMIT + i + 1}</td>
                  <td style={tdStyle}>
                    <span style={{
                      padding: '1px 6px',
                      borderRadius: '3px',
                      fontSize: '10px',
                      fontWeight: 600,
                      background: sourceColor(r.source),
                      color: '#fff',
                    }}>{r.source}</span>
                  </td>
                  <td style={{ ...tdStyle, fontWeight: 500, maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.company}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {cleanHtml(r.title)}
                  </td>
                  <td style={tdStyle}>
                    {r.form_provider ? (
                      <span style={{ padding: '1px 5px', borderRadius: '3px', fontSize: '10px', background: '#e0e7ff', color: '#3730a3' }}>
                        {r.form_provider}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    {r.field_count ?? '—'}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '320px' }}>
                    {r.final_form_url || r.resolved_apply_url ? (
                      <a
                        href={r.final_form_url || r.resolved_apply_url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: '#2563eb',
                          textDecoration: 'none',
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={r.final_form_url || r.resolved_apply_url || ''}
                      >
                        {shortenUrl(r.final_form_url || r.resolved_apply_url || '')}
                      </a>
                    ) : r.last_resolution_error ? (
                      <span style={{ color: '#dc2626', fontSize: '11px' }}>{r.last_resolution_error.slice(0, 60)}</span>
                    ) : '—'}
                  </td>
                  <td style={{ ...tdStyle, fontSize: '10px', color: 'var(--color-text-dim)' }}>
                    {r.resolver_version}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center' }}>
          <button
            disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}
            style={paginationBtnStyle(page === 0)}
          >← Prev</button>
          <span style={{ fontSize: '12px', color: 'var(--color-text-dim)' }}>
            Page {page + 1} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            style={paginationBtnStyle(page >= totalPages - 1)}
          >Next →</button>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: '11px',
  fontWeight: 600,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '6px 10px',
  whiteSpace: 'nowrap',
};

function paginationBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    fontSize: '12px',
    borderRadius: '4px',
    border: '1px solid var(--color-border)',
    background: disabled ? 'transparent' : 'var(--color-panel)',
    color: disabled ? 'var(--color-text-dim)' : 'var(--color-text-primary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

function sourceColor(source: string): string {
  switch (source) {
    case 'hn_hiring': return '#f97316';
    case 'reed': return '#2563eb';
    case 'devitjobs': return '#059669';
    case 'linkedin': return '#0a66c2';
    case 'remoteok': return '#7c3aed';
    case 'jooble': return '#dc2626';
    default: return '#6b7280';
  }
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url.slice(0, 60);
  }
}

function cleanHtml(text: string): string {
  return text
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&#x3D;/g, '=')
    .replace(/<[^>]+>/g, '');
}
