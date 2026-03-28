/**
 * Content hash — cross-platform fingerprint.
 *
 * Two layers:
 *   1. identity_hash: company + title (cross-platform duplicate detection)
 *   2. payload_hash: full JD content (snapshot change detection)
 *
 * identity_hash is used in content_index for cross-source linking.
 * payload_hash is used in jobs_current / job_snapshots for change detection.
 */

import { createHash } from "node:crypto";

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

export function identityHash(companyName: string, jobTitle: string): string {
  const input = `${normalize(companyName)}|${normalize(jobTitle)}`;
  return createHash("sha256").update(input).digest("hex");
}

export function payloadHash(
  companyName: string,
  jobTitle: string,
  jdRaw: string,
  location?: string,
): string {
  const parts = [
    normalize(companyName),
    normalize(jobTitle),
    normalize(jdRaw).slice(0, 2000),
  ];
  if (location) parts.push(normalize(location));
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
