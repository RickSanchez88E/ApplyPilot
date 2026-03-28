import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ProgressState, ProgressLogEntry } from '../hooks/useProgress';

const STAGE_LABELS: Record<string, string> = {
  idle: 'Ready',
  initializing: 'Initializing...',
  checking_session: 'Checking session...',
  scraping_page: 'Scraping...',
  parsing_details: 'Parsing details...',
  ats_enhancement: 'Enhancing data...',
  dedup_insert: 'Deduplicating...',
  completed: 'Complete',
  error: 'Error',
};

const LEVEL_COLORS: Record<string, string> = {
  info: 'var(--color-text-dim)',
  warn: 'var(--color-warning)',
  error: 'var(--color-danger)',
  success: 'var(--color-success)',
};

const AUTO_DISMISS_MS = 8000;

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ProgressBar({ progress }: { progress: ProgressState | null }) {
  const [dismissedTerminalUpdatedAt, setDismissedTerminalUpdatedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const stage = progress?.stage ?? 'idle';
  const isTerminal = stage === 'completed' || stage === 'error';

  useEffect(() => {
    if (!isTerminal || !progress?.updatedAt) return;

    const terminalUpdatedAt = progress.updatedAt;
    const timer = setTimeout(() => {
      setDismissedTerminalUpdatedAt(terminalUpdatedAt);
    }, AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [isTerminal, progress?.updatedAt]);

  useEffect(() => {
    if (expanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [progress?.logs?.length, expanded]);

  if (!progress) return null;

  const { percent, message, stats, logs = [] } = progress;
  const isComplete = stage === 'completed';
  const isError = stage === 'error';
  const isActive = stage !== 'idle' && !isTerminal;
  const dismissed = isTerminal && dismissedTerminalUpdatedAt === progress.updatedAt;

  if (stage === 'idle' || dismissed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="panel overflow-hidden"
      >
        <div className="px-4 pt-3 pb-2">
          <div className="flex justify-between items-center mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              {isActive && (
                <div className="w-3 h-3 shrink-0 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
              )}
              {isComplete && <span className="text-[var(--color-success)] text-sm font-semibold shrink-0">✓</span>}
              {isError && <span className="text-[var(--color-danger)] text-sm font-semibold shrink-0">✕</span>}
              <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] shrink-0">
                {STAGE_LABELS[stage] || stage}
              </span>
              <span className="text-[11px] font-mono text-[var(--color-text-dim)] truncate">
                - {message}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {(stats.jobsInserted > 0 || stats.jobsParsed > 0) && (
                <span className="text-[10px] font-mono text-[var(--color-text-dim)]">
                  {stats.jobsInserted > 0 && `+${stats.jobsInserted}`}
                  {stats.jobsSkipped > 0 && ` / ${stats.jobsSkipped} skip`}
                </span>
              )}
              <span className="text-[11px] font-mono text-[var(--color-text-dim)] w-8 text-right">{percent}%</span>
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-[10px] font-mono text-[var(--color-accent)] hover:underline px-1"
              >
                {expanded ? '▲ Hide' : '▼ Log'}
              </button>
            </div>
          </div>

          <div className="h-1 w-full bg-[var(--color-surface)] rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(percent, 2)}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              className={`h-full rounded-full ${
                isError ? 'bg-[var(--color-danger)]'
                : isComplete ? 'bg-[var(--color-success)]'
                : 'bg-[var(--color-accent)]'
              }`}
            />
          </div>
        </div>

        <AnimatePresence>
          {expanded && logs.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-t border-[var(--color-border)]"
            >
              <div
                className="max-h-52 overflow-y-auto px-4 py-2 space-y-0.5"
                style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '11px', lineHeight: '1.6' }}
              >
                {logs.map((entry: ProgressLogEntry, i: number) => (
                  <div key={`${entry.ts}-${i}`} className="flex gap-2">
                    <span className="text-[var(--color-text-dim)] shrink-0 w-16 text-right opacity-50">{formatTs(entry.ts)}</span>
                    <span style={{ color: LEVEL_COLORS[entry.level] || LEVEL_COLORS.info }}>
                      {entry.msg}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
