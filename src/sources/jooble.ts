/**
 * Jooble source adapter v4 — CF-bypass + strict quality gate.
 *
 * Uses cf-bypass-scraper skill (navigateWithCf + CDP persistent context).
 * ONLY stores jobs that pass quality validation:
 *   - Title must be a real job title (not CF garbage)
 *   - JD/snippet must be ≥50 chars of real content
 *   - No CF challenge text (Just a moment, Checking browser, etc.)
 *
 * Strategy:
 *   1. Search page → extract all job cards via CDP (real Chrome, CF auto-pass)
 *   2. Top 3 per keyword → scrape /desc/ for full JD
 *   3. Everything gets strict quality check before returning
 */
import type { SourceAdapter, FetchOptions } from "./adapter.js";
import type { NewJob } from "../shared/types.js";
import { createChildLogger } from "../lib/logger.js";
import { scrapeJoobleForKeyword } from "./jooble-browser.js";

const log = createChildLogger({ module: "source-jooble" });

/** Cloudflare garbage patterns — any match = reject */
const CF_GARBAGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /cf-browser-verification/i,
  /cloudflare/i,
  /enable javascript/i,
  /ray id/i,
  /turnstile/i,
  /attention required/i,
  /please wait/i,
  /security check/i,
  /verifying you are human/i,
  /challenge-platform/i,
];

/** Minimum quality thresholds */
const MIN_TITLE_LENGTH = 5;
const MIN_DESCRIPTION_LENGTH = 50;

function isGarbageContent(text: string): boolean {
  if (!text || text.length < 10) return true;
  return CF_GARBAGE_PATTERNS.some((pat) => pat.test(text));
}

function isValidJob(
  title: string,
  description: string,
): { valid: boolean; reason?: string } {
  if (!title || title.length < MIN_TITLE_LENGTH) {
    return { valid: false, reason: `title too short (${title?.length ?? 0})` };
  }
  if (isGarbageContent(title)) {
    return { valid: false, reason: "title contains CF garbage" };
  }
  if (!description || description.length < MIN_DESCRIPTION_LENGTH) {
    return { valid: false, reason: `description too short (${description?.length ?? 0})` };
  }
  if (isGarbageContent(description)) {
    return { valid: false, reason: "description contains CF garbage" };
  }
  return { valid: true };
}

export const joobleAdapter: SourceAdapter = {
  name: "jooble",
  displayName: "Jooble",
  supportsNativeTimeFilter: false,
  minTimeGranularityHours: null,

  async fetchJobs(keywords: string[], location: string, _options?: FetchOptions): Promise<NewJob[]> {
    const allJobs: NewJob[] = [];
    let rejected = 0;

    for (const kw of keywords) {
      try {
        log.info({ keyword: kw, location }, "Fetching Jooble jobs (CDP persistent context, CF-bypass)");

        const details = await scrapeJoobleForKeyword(kw, location);

        for (const detail of details) {
          // ── STRICT QUALITY GATE ──
          const check = isValidJob(detail.title, detail.description);
          if (!check.valid) {
            rejected++;
            log.debug(
              { title: detail.title?.slice(0, 30), reason: check.reason },
              "Rejected garbage job",
            );
            continue;
          }

          allJobs.push({
            companyName: detail.company || "Unknown",
            jobTitle: detail.title,
            location: detail.location || location,
            salaryText: detail.salary || undefined,
            jdRaw: detail.description,
            applyUrl: detail.applyUrl || detail.sourceUrl,
            applyType: "external",
            source: "jooble",
            sourceUrl: detail.sourceUrl,
          });
        }

        log.info({ keyword: kw, accepted: details.length - rejected, rejected }, "Jooble keyword complete");
      } catch (err) {
        log.error({ err, keyword: kw }, "Jooble fetch failed");
      }
    }

    log.info(
      { totalAccepted: allJobs.length, totalRejected: rejected, keywords: keywords.length },
      "Jooble adapter complete (quality-gated)",
    );
    return allJobs;
  },
};
