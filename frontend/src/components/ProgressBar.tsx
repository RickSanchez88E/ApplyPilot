import { motion, AnimatePresence } from 'framer-motion';
import type { ProgressState } from '../hooks/useProgress';

const STAGE_LABELS: Record<string, string> = {
  idle: 'Ready',
  initializing: 'Initializing…',
  checking_session: 'Checking session…',
  scraping_page: 'Scraping…',
  parsing_details: 'Parsing details…',
  ats_enhancement: 'Enhancing data…',
  dedup_insert: 'Deduplicating & inserting…',
  completed: 'Complete',
  error: 'Error',
};

export function ProgressBar({ progress }: { progress: ProgressState | null }) {
  if (!progress) return null;

  const { stage, percent, message, stats } = progress;
  const isActive = stage !== 'idle' && stage !== 'completed' && stage !== 'error';
  const isComplete = stage === 'completed';
  const isError = stage === 'error';

  if (stage === 'idle') return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="panel p-4 overflow-hidden"
      >
        {/* Stage label + percent */}
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            {isActive && (
              <div className="w-3 h-3 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
            )}
            {isComplete && (
              <span className="text-[var(--color-success)] text-sm font-semibold">✓</span>
            )}
            {isError && (
              <span className="text-[var(--color-danger)] text-sm font-semibold">✗</span>
            )}
            <span className="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
              {STAGE_LABELS[stage] || stage}
            </span>
          </div>
          <span className="text-xs font-mono text-[var(--color-text-dim)]">
            {percent}%
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 w-full bg-[var(--color-surface)] rounded-full overflow-hidden mb-2">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(percent, 2)}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className={`h-full rounded-full ${
              isError
                ? 'bg-[var(--color-danger)]'
                : isComplete
                ? 'bg-[var(--color-success)]'
                : 'bg-[var(--color-accent)]'
            }`}
          />
        </div>

        {/* Message */}
        <p className="text-[11px] font-mono text-[var(--color-text-dim)] mb-1 truncate">
          {message}
        </p>

        {/* Live stats */}
        {isActive && (stats.jobsInserted > 0 || stats.jobsParsed > 0) && (
          <div className="flex gap-4 text-[10px] font-mono text-[var(--color-text-dim)] mt-1">
            {stats.jobsParsed > 0 && <span>Parsed: {stats.jobsParsed}</span>}
            {stats.jobsInserted > 0 && <span>Inserted: {stats.jobsInserted}</span>}
            {stats.jobsSkipped > 0 && <span>Skipped: {stats.jobsSkipped}</span>}
            {stats.errors > 0 && <span className="text-[var(--color-danger)]">Errors: {stats.errors}</span>}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
