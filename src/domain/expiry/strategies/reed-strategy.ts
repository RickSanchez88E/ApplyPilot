/**
 * Reed expiry strategy.
 *
 * Reed has clean HTTP signals: 404/410 = expired, clear page text.
 * Classified as "strong evidence" platform.
 */

import { collectHttpEvidence } from "../evidence-collector.js";
import type { SourceExpiryStrategy, AvailabilityEvidence, ExpiryDecision, ExpiryJobContext } from "../types.js";

export class ReedExpiryStrategy implements SourceExpiryStrategy {
  readonly source = "reed";

  async collectEvidence(job: ExpiryJobContext): Promise<AvailabilityEvidence> {
    const url = job.applyUrl || job.canonicalUrl;
    if (!url || url === "#") {
      return { errorMessage: "no URL to verify" };
    }
    return collectHttpEvidence(url);
  }

  classify(evidence: AvailabilityEvidence, _job: ExpiryJobContext): ExpiryDecision {
    if (evidence.isUnreachable) {
      return { action: "fetch_failed", reason: `unreachable: ${evidence.errorMessage}` };
    }

    if (evidence.httpStatus === 404 || evidence.httpStatus === 410) {
      return { action: "expired", reason: `HTTP ${evidence.httpStatus}` };
    }

    if (evidence.pagePattern) {
      return { action: "expired", reason: `page pattern: ${evidence.pagePattern}` };
    }

    if (evidence.isBlocked) {
      return { action: "blocked", reason: `blocked: ${evidence.pagePattern}` };
    }

    if (evidence.httpStatus && evidence.httpStatus >= 200 && evidence.httpStatus < 400) {
      return { action: "active", reason: `HTTP ${evidence.httpStatus}` };
    }

    return { action: "no_change", reason: "inconclusive" };
  }
}
