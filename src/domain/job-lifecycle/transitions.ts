/**
 * Allowed state transitions for job availability.
 *
 * Enforced at the domain layer — repositories must call `assertTransition`
 * before writing a status change.
 */

import type { JobAvailabilityStatus } from "./job-status.js";

const ALLOWED_TRANSITIONS: ReadonlyMap<JobAvailabilityStatus, ReadonlySet<JobAvailabilityStatus>> =
  new Map([
    ["active", new Set<JobAvailabilityStatus>(["suspected_expired", "fetch_failed", "blocked"])],
    ["suspected_expired", new Set<JobAvailabilityStatus>(["active", "expired"])],
    ["expired", new Set<JobAvailabilityStatus>(["active"])],
    ["fetch_failed", new Set<JobAvailabilityStatus>(["active", "suspected_expired", "blocked"])],
    ["blocked", new Set<JobAvailabilityStatus>(["active", "fetch_failed"])],
  ]);

export function canTransition(from: JobAvailabilityStatus, to: JobAvailabilityStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransition(from: JobAvailabilityStatus, to: JobAvailabilityStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job status transition: ${from} → ${to}`);
  }
}
