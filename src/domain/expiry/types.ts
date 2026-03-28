/**
 * Expiry domain types — evidence model and strategy interface.
 */

import type { JobAvailabilityStatus } from "../job-lifecycle/job-status.js";

export interface AvailabilityEvidence {
  httpStatus?: number;
  /** Matched text pattern from page body (e.g. "job not found") */
  pagePattern?: string;
  /** Whether CF/captcha/authwall was detected */
  isBlocked?: boolean;
  /** Whether the page was unreachable (timeout, DNS, etc) */
  isUnreachable?: boolean;
  /** Raw error message if fetch failed */
  errorMessage?: string;
  /** Source-specific metadata */
  meta?: Record<string, unknown>;
}

export type ExpiryDecision =
  | { action: "expired"; reason: string }
  | { action: "suspected_expired"; reason: string }
  | { action: "blocked"; reason: string }
  | { action: "fetch_failed"; reason: string }
  | { action: "active"; reason: string }
  | { action: "no_change"; reason: string };

export interface SourceExpiryStrategy {
  readonly source: string;
  collectEvidence(job: ExpiryJobContext): Promise<AvailabilityEvidence>;
  classify(evidence: AvailabilityEvidence, job: ExpiryJobContext): ExpiryDecision;
}

export interface ExpiryJobContext {
  jobKey: string;
  source: string;
  applyUrl: string | null;
  canonicalUrl: string | null;
  consecutiveMissingCount: number;
  currentStatus: JobAvailabilityStatus;
}
