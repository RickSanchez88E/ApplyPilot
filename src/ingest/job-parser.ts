/**
 * Pure-function parsers: HTML/JSON → NewJob objects using cheerio.
 * No side effects, no I/O — just data transformation.
 */

import * as cheerio from "cheerio";
import { parseLinkedInJobDetailHtml } from "./linkedin-job-detail.js";
import { createChildLogger } from "../lib/logger.js";
import type { NewJob, AtsPlatform } from "../shared/types.js";

const log = createChildLogger({ module: "parser" });

const ATS_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly platform: AtsPlatform;
}> = [
  { pattern: /workday\.com/i, platform: "workday" },
  { pattern: /myworkdayjobs\.com/i, platform: "workday" },
  { pattern: /greenhouse\.io/i, platform: "greenhouse" },
  { pattern: /boards\.greenhouse/i, platform: "greenhouse" },
  { pattern: /jobs\.lever\.co/i, platform: "lever" },
  { pattern: /jobs\.ashbyhq\.com/i, platform: "ashby" },
  { pattern: /apply\.workable\.com/i, platform: "workable" },
  { pattern: /breezy\.hr/i, platform: "breezyhr" },
  { pattern: /jobs\.smartrecruiters\.com/i, platform: "smartrecruiters" },
  { pattern: /bamboohr\.com\/careers/i, platform: "bamboohr" },
  { pattern: /bamboohr\.co\.uk\/jobs/i, platform: "bamboohr" },
  { pattern: /successfactors\.com/i, platform: "successfactors" },
  { pattern: /successfactors\.eu/i, platform: "successfactors" },
  { pattern: /taleo\.net/i, platform: "taleo" },
  { pattern: /icims\.com/i, platform: "icims" }
];

/**
 * Parse LinkedIn job search results page HTML into NewJob stubs.
 * These are partial — they lack jdRaw which requires fetching individual pages.
 */
export function parseSearchResultsHtml(
  html: string,
): ReadonlyArray<Partial<NewJob> & { readonly linkedinUrl: string }> {
  const $ = cheerio.load(html);
  const results: Array<Partial<NewJob> & { readonly linkedinUrl: string }> = [];

  $("li.jobs-search-results__list-item, li.job-search-card, div.base-card").each((_i, el) => {
    try {
      const card = $(el);
      const parsed = parseSearchCard($, card);
      if (parsed) {
        results.push(parsed);
      }
    } catch (err) {
      log.debug({ err }, "Failed to parse search result card, skipping");
    }
  });

  log.info({ count: results.length }, "Parsed search results from HTML");
  return results;
}

/**
 * Parse LinkedIn Voyager API JSON response into NewJob stubs.
 */
export function parseSearchResultsJson(
  data: unknown,
): ReadonlyArray<Partial<NewJob> & { readonly linkedinUrl: string }> {
  const results: Array<Partial<NewJob> & { readonly linkedinUrl: string }> = [];

  if (!data || typeof data !== "object") {
    log.warn("Invalid JSON data for search results parsing");
    return results;
  }

  const elements = extractElements(data);

  for (const element of elements) {
    try {
      const parsed = parseApiElement(element);
      if (parsed) {
        results.push(parsed);
      }
    } catch (err) {
      log.debug({ err }, "Failed to parse API element, skipping");
    }
  }

  log.info({ count: results.length }, "Parsed search results from JSON");
  return results;
}

/**
 * Parse a full job detail page HTML to extract the raw JD text.
 */
export function parseJobDetailHtml(html: string): {
  readonly jdRaw: string;
  readonly applyType: "easy_apply" | "external";
  readonly applyUrl: string | null;
  readonly atsPlatform: AtsPlatform | null;
} {
  return parseLinkedInJobDetailHtml(html);
}

/**
 * Merge a search result stub with job detail data into a complete NewJob.
 */
export function mergeIntoNewJob(
  stub: Partial<NewJob> & { readonly linkedinUrl: string },
  detail: {
    readonly jdRaw: string;
    readonly applyType: "easy_apply" | "external";
    readonly applyUrl: string | null;
    readonly atsPlatform: AtsPlatform | null;
  },
): NewJob {
  return {
    linkedinUrl: stub.linkedinUrl,
    companyName: stub.companyName ?? "Unknown",
    jobTitle: stub.jobTitle ?? "Unknown",
    location: stub.location,
    workMode: stub.workMode,
    salaryText: stub.salaryText,
    postedDate: stub.postedDate,
    jdRaw: detail.jdRaw,
    applyType: detail.applyType,
    applyUrl: detail.applyUrl ?? undefined,
    atsPlatform: detail.atsPlatform ?? undefined,
    source: "linkedin",
    sourceUrl: stub.linkedinUrl,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseSearchCard(
  _$: cheerio.CheerioAPI,
  card: ReturnType<cheerio.CheerioAPI>,
): (Partial<NewJob> & { readonly linkedinUrl: string }) | null {
  const rawUrl =
    card
      .find("a.base-card__full-link, a.job-card-container__link, a.job-card-list__title")
      .attr("href") ?? card.find("a[href*='/jobs/view/']").attr("href");

  if (!rawUrl) return null;

  const linkedinUrl = normalizeLinkedInUrl(rawUrl);

  const jobTitle = cleanText(
    card
      .find("h3.base-search-card__title, h3.job-card-list__title, .job-card-container__link span")
      .text(),
  );

  const companyName = cleanText(
    card
      .find("h4.base-search-card__subtitle a, .job-card-container__primary-description")
      .first()
      .text(),
  );

  const location =
    cleanText(card.find("span.job-search-card__location").first().text()) || undefined;

  const salaryText =
    cleanText(
      card.find("span.job-search-card__salary-info, .salary-main-rail__data-amount").text(),
    ) || undefined;

  const workMode = detectWorkMode(location ?? "", jobTitle);

  const timeTag = card.find("time").attr("datetime");
  const postedDate = timeTag ? new Date(timeTag) : undefined;

  const hasEasyApply =
    card
      .find(".job-card-container__apply-method, .base-search-card__metadata .result-benefits__text")
      .text()
      .toLowerCase()
      .includes("easy apply") || card.find("[data-is-easy-apply='true']").length > 0;

  return {
    linkedinUrl,
    jobTitle: jobTitle || undefined,
    companyName: companyName || undefined,
    location,
    salaryText,
    workMode,
    postedDate,
    applyType: hasEasyApply ? "easy_apply" : "external",
  };
}

function extractElements(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj["elements"])) {
    return obj["elements"];
  }
  if (Array.isArray(obj["included"])) {
    return obj["included"];
  }
  if (obj["data"] && typeof obj["data"] === "object") {
    const inner = obj["data"] as Record<string, unknown>;
    if (Array.isArray(inner["elements"])) {
      return inner["elements"];
    }
  }

  return [];
}

function parseApiElement(
  element: unknown,
): (Partial<NewJob> & { readonly linkedinUrl: string }) | null {
  if (!element || typeof element !== "object") return null;
  const el = element as Record<string, unknown>;

  const entityUrn = el["entityUrn"] as string | undefined;
  const trackingUrn = el["trackingUrn"] as string | undefined;

  const jobId = extractJobIdFromUrn(entityUrn) ?? extractJobIdFromUrn(trackingUrn);

  if (!jobId) return null;

  const linkedinUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

  const title = (el["title"] as string | undefined) ?? "";
  const companyName =
    ((el["companyName"] as string | undefined) ?? getNestedString(el, "company", "name")) ||
    undefined;

  const location =
    ((el["formattedLocation"] as string | undefined) ?? (el["location"] as string | undefined)) ||
    undefined;

  const workMode = detectWorkMode(location ?? "", title);

  return {
    linkedinUrl,
    jobTitle: title || undefined,
    companyName,
    location,
    workMode,
  };
}

function extractJobIdFromUrn(urn: string | undefined): string | null {
  if (!urn) return null;
  const match = urn.match(/(\d{5,})/);
  return match?.[1] ?? null;
}

function getNestedString(obj: Record<string, unknown>, ...keys: string[]): string {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "";
}

export function detectAtsPlatform(url: string): AtsPlatform | null {
  for (const { pattern, platform } of ATS_PATTERNS) {
    if (pattern.test(url)) {
      return platform;
    }
  }
  if (url.startsWith("http")) {
    return "generic";
  }
  return null;
}

function detectWorkMode(
  location: string,
  title: string,
): "remote" | "hybrid" | "onsite" | undefined {
  const combined = `${location} ${title}`.toLowerCase();

  if (combined.includes("remote")) return "remote";
  if (combined.includes("hybrid")) return "hybrid";
  if (combined.includes("on-site") || combined.includes("onsite")) return "onsite";

  return undefined;
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function normalizeLinkedInUrl(raw: string): string {
  const trimmed = raw.trim();

  const match = trimmed.match(/\/jobs\/view\/[^/]*?(\d{8,})/);
  if (match?.[1]) {
    return `https://www.linkedin.com/jobs/view/${match[1]}/`;
  }

  try {
    const url = new URL(
      trimmed.startsWith("http") ? trimmed : `https://www.linkedin.com${trimmed}`,
    );
    url.hostname = "www.linkedin.com";
    url.search = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}
