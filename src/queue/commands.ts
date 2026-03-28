/**
 * Queue command definitions — typed payloads for each task type.
 */

export const QUEUE_NAMES = {
  general: "worker-general",
  browser: "worker-browser",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface DiscoverJobsPayload {
  type: "discover_jobs";
  source: string;
  keywords?: string[];
  location?: string;
  timeFilter?: string;
}

export interface VerifyJobPayload {
  type: "verify_job";
  jobKey: string;
  source: string;
}

export interface EnrichJobPayload {
  type: "enrich_job";
  jobKey: string;
  source: string;
}

export interface RecheckExpiryPayload {
  type: "recheck_expiry";
  jobKey: string;
  source: string;
}

export interface RefreshCursorPayload {
  type: "refresh_source_cursor";
  source: string;
}

export type CommandPayload =
  | DiscoverJobsPayload
  | VerifyJobPayload
  | EnrichJobPayload
  | RecheckExpiryPayload
  | RefreshCursorPayload;

const BROWSER_SOURCES = new Set(["linkedin", "jooble"]);

export function routeCommand(payload: CommandPayload): QueueName {
  if (payload.type === "discover_jobs" && BROWSER_SOURCES.has(payload.source)) {
    return QUEUE_NAMES.browser;
  }
  if (payload.type === "verify_job" && BROWSER_SOURCES.has(payload.source)) {
    return QUEUE_NAMES.browser;
  }
  if (payload.type === "enrich_job" && BROWSER_SOURCES.has(payload.source)) {
    return QUEUE_NAMES.browser;
  }
  return QUEUE_NAMES.general;
}
