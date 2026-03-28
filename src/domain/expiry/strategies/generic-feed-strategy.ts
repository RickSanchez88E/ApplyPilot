/**
 * Generic feed strategy — for HN Hiring, RemoteOK, DevITJobs.
 *
 * These are feed/discovery sources with weak detail-page signals.
 * Missing from list once → suspected_expired.
 * Consecutive missing ≥3 → expired.
 * Single missing never directly expires.
 */

import { collectHttpEvidence } from "../evidence-collector.js";
import type { SourceExpiryStrategy, AvailabilityEvidence, ExpiryDecision, ExpiryJobContext } from "../types.js";

const CONSECUTIVE_THRESHOLD = 3;

export class GenericFeedExpiryStrategy implements SourceExpiryStrategy {
  readonly source = "generic";

  async collectEvidence(job: ExpiryJobContext): Promise<AvailabilityEvidence> {
    const url = job.canonicalUrl || job.applyUrl;
    if (!url || url === "#") {
      return { meta: { listMissing: true } };
    }
    return collectHttpEvidence(url);
  }

  classify(evidence: AvailabilityEvidence, job: ExpiryJobContext): ExpiryDecision {
    if (evidence.isUnreachable) {
      return { action: "fetch_failed", reason: `unreachable: ${evidence.errorMessage}` };
    }

    if (evidence.isBlocked) {
      return { action: "blocked", reason: `blocked: ${evidence.pagePattern}` };
    }

    if (evidence.httpStatus === 404 || evidence.httpStatus === 410) {
      if (job.consecutiveMissingCount >= CONSECUTIVE_THRESHOLD) {
        return { action: "expired", reason: `HTTP ${evidence.httpStatus} + ${job.consecutiveMissingCount} consecutive misses` };
      }
      return { action: "suspected_expired", reason: `HTTP ${evidence.httpStatus}, missing count ${job.consecutiveMissingCount}` };
    }

    if (evidence.pagePattern) {
      return { action: "expired", reason: `page pattern: ${evidence.pagePattern}` };
    }

    // List-only missing (no URL to check)
    if (evidence.meta?.listMissing) {
      if (job.consecutiveMissingCount >= CONSECUTIVE_THRESHOLD) {
        return { action: "expired", reason: `missing from list ${job.consecutiveMissingCount} times` };
      }
      return { action: "suspected_expired", reason: `missing from list, count ${job.consecutiveMissingCount}` };
    }

    if (evidence.httpStatus && evidence.httpStatus >= 200 && evidence.httpStatus < 400) {
      return { action: "active", reason: `HTTP ${evidence.httpStatus}` };
    }

    return { action: "no_change", reason: "inconclusive" };
  }
}
