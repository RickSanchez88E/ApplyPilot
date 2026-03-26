/**
 * Precision-aware date formatting.
 *
 * AUDIT FIX (2026-03-26):
 * Reed and LinkedIn only provide day-level precision (DD/MM/YYYY → 00:00:00 UTC).
 * Using formatDistanceToNow on these produces misleading "about 19 hours ago"
 * when the job was posted today but the timestamp is midnight.
 *
 * This module:
 *   - For `day` precision: renders "Today", "Yesterday", or "Mar 26"
 *   - For `datetime` precision: renders "2 hours ago" etc.
 *   - Falls back to day-level display if precision is unknown but midnight is detected
 */
import { formatDistanceToNow, isToday, isYesterday, format } from 'date-fns'

export const SOURCES: Record<string, { label: string, text: string, bg: string, linkReliable: boolean }> = {
  linkedin: { label: 'LinkedIn', text: 'text-blue-700', bg: 'bg-blue-50', linkReliable: true },
  devitjobs: { label: 'DevIT', text: 'text-emerald-700', bg: 'bg-emerald-50', linkReliable: true },
  reed: { label: 'Reed', text: 'text-rose-700', bg: 'bg-rose-50', linkReliable: true },
  jooble: { label: 'Jooble', text: 'text-indigo-700', bg: 'bg-indigo-50', linkReliable: false },
  hn_hiring: { label: 'HN', text: 'text-orange-700', bg: 'bg-orange-50', linkReliable: true },
  remoteok: { label: 'RemoteOK', text: 'text-teal-700', bg: 'bg-teal-50', linkReliable: true },
}

/**
 * Determines if a Date object has only day-level precision (midnight UTC).
 * Used as a fallback when posted_date_precision is not provided.
 */
function isMidnightUTC(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

/**
 * Render a day-only date as "Today", "Yesterday", or "Mar 26".
 * No fake hour-level precision.
 */
function formatDayOnly(d: Date): string {
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  // Within last 7 days → "3 days ago"
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays <= 7) return `${diffDays}d ago`;
  // Older → compact date
  return format(d, 'MMM d');
}

/**
 * Precision-aware time display.
 * @param dateStr  - ISO date string from API
 * @param precision - 'day' | 'datetime' | null from posted_date_precision computed column
 */
export function formatAgo(dateStr: string, precision?: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';

  // Explicit day precision from API
  if (precision === 'day') {
    return formatDayOnly(d);
  }

  // Explicit datetime precision → use relative time
  if (precision === 'datetime') {
    return formatDistanceToNow(d, { addSuffix: true });
  }

  // No precision info provided → heuristic: midnight UTC = day-only
  if (isMidnightUTC(d)) {
    return formatDayOnly(d);
  }

  // Default: precise relative time
  return formatDistanceToNow(d, { addSuffix: true });
}
