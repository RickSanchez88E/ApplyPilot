/**
 * Expiry judge — routes to the correct platform strategy and produces a decision.
 *
 * Workflow: collectEvidence → classify → return decision
 * The caller (workflow/worker) is responsible for applying the decision (status transition).
 */

import type { SourceExpiryStrategy, ExpiryDecision, ExpiryJobContext } from "./types.js";
import { ReedExpiryStrategy } from "./strategies/reed-strategy.js";
import { JoobleExpiryStrategy } from "./strategies/jooble-strategy.js";
import { LinkedInExpiryStrategy } from "./strategies/linkedin-strategy.js";
import { GenericFeedExpiryStrategy } from "./strategies/generic-feed-strategy.js";

const STRATEGY_MAP = new Map<string, SourceExpiryStrategy>([
  ["reed", new ReedExpiryStrategy()],
  ["jooble", new JoobleExpiryStrategy()],
  ["linkedin", new LinkedInExpiryStrategy()],
  ["hn_hiring", new GenericFeedExpiryStrategy()],
  ["remoteok", new GenericFeedExpiryStrategy()],
  ["devitjobs", new GenericFeedExpiryStrategy()],
]);

export function getStrategyForSource(source: string): SourceExpiryStrategy {
  return STRATEGY_MAP.get(source) ?? new GenericFeedExpiryStrategy();
}

export async function judgeExpiry(job: ExpiryJobContext): Promise<ExpiryDecision> {
  const strategy = getStrategyForSource(job.source);
  const evidence = await strategy.collectEvidence(job);
  return strategy.classify(evidence, job);
}
