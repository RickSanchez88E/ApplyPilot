/**
 * Generic HTTP evidence collector — fetches a URL and extracts availability signals.
 *
 * Used by platform strategies as a building block (not called directly by workflows).
 */

import type { AvailabilityEvidence } from "./types.js";

const EXPIRED_PATTERNS = [
  /the job has expired/i,
  /this job is no longer available/i,
  /the job position is no longer available/i,
  /this position has been filled/i,
  /listing has expired/i,
  /no longer accepting applications/i,
  /job not found/i,
  /this vacancy has been closed/i,
  /position is no longer available/i,
];

const BLOCKED_PATTERNS = [
  /checking your browser/i,
  /just a moment/i,
  /cloudflare/i,
  /captcha/i,
  /access denied/i,
  /authwall/i,
  /sign in to continue/i,
  /please verify you are a human/i,
];

export async function collectHttpEvidence(url: string, timeoutMs = 10_000): Promise<AvailabilityEvidence> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    clearTimeout(timer);

    const body = await resp.text();
    const snippet = body.slice(0, 5000);

    const blocked = BLOCKED_PATTERNS.find((p) => p.test(snippet));
    if (blocked) {
      return { httpStatus: resp.status, isBlocked: true, pagePattern: blocked.source };
    }

    const expired = EXPIRED_PATTERNS.find((p) => p.test(snippet));
    if (expired) {
      return { httpStatus: resp.status, pagePattern: expired.source };
    }

    return { httpStatus: resp.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      return { isUnreachable: true, errorMessage: "timeout" };
    }
    return { isUnreachable: true, errorMessage: msg };
  }
}
