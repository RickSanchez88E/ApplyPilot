/**
 * Job availability status — the lifecycle state of a scraped job listing.
 *
 * State machine:
 *   active → suspected_expired → expired
 *   active → blocked (CF / authwall / proxy)
 *   active → fetch_failed (network, retryable)
 *   suspected_expired → active (recovered on re-verify)
 *   blocked → active (unblocked)
 *   fetch_failed → active (retry succeeded)
 */

export const JOB_STATUSES = [
  "active",
  "suspected_expired",
  "expired",
  "fetch_failed",
  "blocked",
] as const;

export type JobAvailabilityStatus = (typeof JOB_STATUSES)[number];

export function isValidJobStatus(s: string): s is JobAvailabilityStatus {
  return (JOB_STATUSES as readonly string[]).includes(s);
}
