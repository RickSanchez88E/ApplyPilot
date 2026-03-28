/**
 * job_key generation — unique identifier for a job across the system.
 *
 * Rules:
 *   1. Prefer: source:external_job_id (platform's own ID)
 *   2. Fallback: source:sha256(canonical_url)
 *   3. Last resort: source:sha256(sourceUrl || linkedinUrl)
 */

import { createHash } from "node:crypto";

export function buildJobKey(
  source: string,
  opts: { externalJobId?: string; canonicalUrl?: string; sourceUrl?: string; linkedinUrl?: string },
): string {
  if (opts.externalJobId) {
    return `${source}:${opts.externalJobId}`;
  }
  const url = opts.canonicalUrl || opts.sourceUrl || opts.linkedinUrl;
  if (!url) {
    throw new Error(`Cannot build job_key for source "${source}": no ID or URL provided`);
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return `${source}:url_${hash}`;
}

export function parseJobKey(jobKey: string): { source: string; identifier: string } {
  const idx = jobKey.indexOf(":");
  if (idx === -1) throw new Error(`Malformed job_key: ${jobKey}`);
  return { source: jobKey.slice(0, idx), identifier: jobKey.slice(idx + 1) };
}
