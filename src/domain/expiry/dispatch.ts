import { dispatch } from "../../queue/setup.js";
import type { RecheckExpiryPayload } from "../../queue/commands.js";

function normalizeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const normalized = url.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildRecheckExpiryPayload(input: {
  jobKey: string;
  source: string;
  applyUrl?: string | null;
  sourceDescUrl?: string | null;
}): RecheckExpiryPayload | null {
  const hasAnyUrl = Boolean(normalizeUrl(input.applyUrl) ?? normalizeUrl(input.sourceDescUrl));
  if (!hasAnyUrl) return null;
  return {
    type: "recheck_expiry",
    jobKey: input.jobKey,
    source: input.source,
  };
}

export async function enqueueRecheckExpiryForJob(input: {
  jobKey: string;
  source: string;
  applyUrl?: string | null;
  sourceDescUrl?: string | null;
}): Promise<string | null> {
  const payload = buildRecheckExpiryPayload(input);
  if (!payload) return null;
  return dispatch(payload);
}
