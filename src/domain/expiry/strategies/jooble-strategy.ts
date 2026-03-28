/**
 * Jooble expiry strategy.
 *
 * Jooble /desc/ pages are behind Cloudflare — CF interstitial must NOT be
 * classified as expired. Only explicit "no longer available" text counts.
 * CF detection → blocked.
 */

import { collectHttpEvidence } from "../evidence-collector.js";
import type { SourceExpiryStrategy, AvailabilityEvidence, ExpiryDecision, ExpiryJobContext } from "../types.js";

export class JoobleExpiryStrategy implements SourceExpiryStrategy {
  readonly source = "jooble";

  async collectEvidence(job: ExpiryJobContext): Promise<AvailabilityEvidence> {
    const url = job.canonicalUrl || job.applyUrl;
    if (!url || url === "#") {
      return { errorMessage: "no URL to verify" };
    }
    return collectHttpEvidence(url);
  }

  classify(evidence: AvailabilityEvidence, _job: ExpiryJobContext): ExpiryDecision {
    if (evidence.isUnreachable) {
      return { action: "fetch_failed", reason: `unreachable: ${evidence.errorMessage}` };
    }

    // CF / captcha / authwall → blocked, never expired
    if (evidence.isBlocked) {
      return { action: "blocked", reason: `Cloudflare/captcha: ${evidence.pagePattern}` };
    }

    if (evidence.httpStatus === 404 || evidence.httpStatus === 410) {
      return { action: "expired", reason: `HTTP ${evidence.httpStatus}` };
    }

    if (evidence.pagePattern) {
      return { action: "expired", reason: `page pattern: ${evidence.pagePattern}` };
    }

    if (evidence.httpStatus && evidence.httpStatus >= 200 && evidence.httpStatus < 400) {
      return { action: "active", reason: `HTTP ${evidence.httpStatus}` };
    }

    return { action: "no_change", reason: "inconclusive" };
  }
}
