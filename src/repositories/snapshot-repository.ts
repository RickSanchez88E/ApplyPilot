/**
 * Repository for public.job_snapshots — content change history.
 *
 * Only writes when content_hash actually changed (caller must check via snapshot-policy).
 */

import { query } from "../db/client.js";

export interface SnapshotInput {
  jobKey: string;
  contentHash: string;
  payload: Record<string, unknown>;
}

export async function insertSnapshot(input: SnapshotInput): Promise<bigint> {
  const res = await query<{ id: string }>(
    `INSERT INTO public.job_snapshots (job_key, content_hash, payload)
     VALUES ($1, $2, $3)
     RETURNING id::text`,
    [input.jobKey, input.contentHash, JSON.stringify(input.payload)],
  );
  return BigInt(res.rows[0]!.id);
}

export async function getLatestSnapshot(jobKey: string) {
  const res = await query<{ content_hash: string; captured_at: Date }>(
    `SELECT content_hash, captured_at FROM public.job_snapshots
     WHERE job_key = $1 ORDER BY captured_at DESC LIMIT 1`,
    [jobKey],
  );
  return res.rows[0] ?? null;
}
