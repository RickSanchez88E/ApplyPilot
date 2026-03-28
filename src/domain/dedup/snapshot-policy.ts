/**
 * Snapshot policy — decides whether a job_snapshots row should be written.
 *
 * Rule: only write when payload_hash differs from the job's current content_hash.
 * Pure timestamp changes (last_seen_at, last_verified_at) never create snapshots.
 */

export function shouldSnapshot(currentHash: string, incomingHash: string): boolean {
  return currentHash !== incomingHash;
}
