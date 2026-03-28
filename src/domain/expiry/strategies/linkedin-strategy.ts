/**
 * LinkedIn expiry strategy.
 *
 * LinkedIn is aggressive with auth walls and session expiry.
 * Key rule: authwall / login redirect / cookie-expired → blocked, NOT expired.
 * Only clear 404 (non-authwall) counts as expired.
 */

import { collectHttpEvidence } from "../evidence-collector.js";
import type { SourceExpiryStrategy, AvailabilityEvidence, ExpiryDecision, ExpiryJobContext } from "../types.js";

const AUTHWALL_PATTERNS = [
  /authwall/i,
  /\/login/i,
  /sign.?in/i,
  /session.?expired/i,
];

export class LinkedInExpiryStrategy implements SourceExpiryStrategy {
  readonly source = "linkedin";

  async collectEvidence(job: ExpiryJobContext): Promise<AvailabilityEvidence> {
    const url = job.canonicalUrl || job.applyUrl;
    if (!url || url === "#") {
      return { errorMessage: "no URL to verify" };
    }
    const evidence = await collectHttpEvidence(url);

    // Post-process: check for authwall in page content
    if (evidence.pagePattern) {
      const isAuth = AUTHWALL_PATTERNS.some((p) => p.test(evidence.pagePattern!));
      if (isAuth) {
        return { ...evidence, isBlocked: true };
      }
    }

    // 302/303 redirects to login → authwall
    if (evidence.httpStatus === 302 || evidence.httpStatus === 303) {
      return { ...evidence, isBlocked: true, pagePattern: "login redirect" };
    }

    return evidence;
  }

  classify(evidence: AvailabilityEvidence, _job: ExpiryJobContext): ExpiryDecision {
    if (evidence.isUnreachable) {
      return { action: "fetch_failed", reason: `unreachable: ${evidence.errorMessage}` };
    }

    // Authwall / session issues → blocked, never expired
    if (evidence.isBlocked) {
      return { action: "blocked", reason: `authwall/session: ${evidence.pagePattern}` };
    }

    if (evidence.httpStatus === 404) {
      return { action: "expired", reason: "HTTP 404 (non-authwall)" };
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
