import * as cheerio from "cheerio";

export interface ParsedLinkedInJobDetail {
  readonly jdRaw: string;
  readonly applyType: "easy_apply" | "external";
  readonly applyUrl: string | null;
  readonly atsPlatform: "workday" | "greenhouse" | "generic" | null;
}

const ATS_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly platform: "workday" | "greenhouse" | "generic";
}> = [
  { pattern: /workday\.com/i, platform: "workday" },
  { pattern: /myworkdayjobs\.com/i, platform: "workday" },
  { pattern: /greenhouse\.io/i, platform: "greenhouse" },
  { pattern: /boards\.greenhouse/i, platform: "greenhouse" },
];

export function parseLinkedInJobDetailHtml(html: string): ParsedLinkedInJobDetail {
  const $ = cheerio.load(html);

  const jdRaw = extractJobDescription($);
  const applyUrl = extractApplyUrl($);
  const applyType = detectApplyType($, applyUrl);
  const atsPlatform = applyUrl ? detectAtsPlatform(applyUrl) : null;

  return { jdRaw, applyType, applyUrl, atsPlatform };
}

export function normalizeExternalApplyUrl(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }

  const cleaned = decodeUrlCandidate(raw);
  if (!cleaned || cleaned.startsWith("javascript:") || cleaned.startsWith("#")) {
    return null;
  }

  try {
    const url = new URL(cleaned, "https://www.linkedin.com");
    const redirectTarget =
      url.searchParams.get("url") ??
      url.searchParams.get("continueUrl") ??
      url.searchParams.get("redirectUrl");

    if (redirectTarget) {
      return normalizeExternalApplyUrl(redirectTarget);
    }

    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }

    if (isLinkedInHost(url.hostname)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function isLinkedInHost(hostname: string): boolean {
  return /(^|\.)linkedin\.com$/i.test(hostname);
}

function extractJobDescription($: cheerio.CheerioAPI): string {
  const selectors = [
    ".show-more-less-html__markup",
    ".description__text",
    "#job-details",
    ".jobs-description__content",
    ".jobs-box__html-content",
    "section.description",
    "article.jobs-description",
  ];

  for (const selector of selectors) {
    const text = normalizeWhitespace($(selector).text());
    if (text.length > 50) {
      return text;
    }
  }

  let longestText = "";
  $("div, section, article").each((_i, el) => {
    const text = normalizeWhitespace($(el).text());
    if (text.length > longestText.length && text.length > 100) {
      longestText = text;
    }
  });

  return longestText || "No description available";
}

function extractApplyUrl($: cheerio.CheerioAPI): string | null {
  const candidates: string[] = [];

  const hrefSelectors = [
    "a.jobs-apply-button",
    "a[data-tracking-control-name='public_jobs_apply-link-offsite']",
    "a[data-tracking-control-name='public_jobs_topcard-orig-link']",
    "a[data-control-name='jobdetails_topcard_inapply']",
    "a.topcard__link",
    "a[href*='externalApply']",
    "a[href*='/redir/redirect']",
  ];

  for (const selector of hrefSelectors) {
    const href = $(selector).attr("href");
    if (href) {
      candidates.push(href);
    }
  }

  const dataUrlAttrs = ["data-apply-url", "data-application-url", "data-job-apply-url"];
  for (const attr of dataUrlAttrs) {
    const value = $(`[${attr}]`).attr(attr);
    if (value) {
      candidates.push(value);
    }
  }

  const inlineApplyUrl = $("code#applyUrl").text();
  if (inlineApplyUrl) {
    candidates.push(inlineApplyUrl);
  }

  for (const candidate of candidates) {
    const normalized = normalizeExternalApplyUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const html = $.html();
  const inlinePatterns = [
    /"(?:applyUrl|companyApplyUrl|offsiteApplyUrl|externalApplyUrl)"\s*:\s*"([^"]+)"/gi,
    /"(?:applyUrl|companyApplyUrl|offsiteApplyUrl|externalApplyUrl)"\s*:\s*\{"[^"]*"\s*:\s*"([^"]+)"/gi,
  ];

  for (const pattern of inlinePatterns) {
    for (const match of html.matchAll(pattern)) {
      const candidate = match[1];
      if (!candidate) {
        continue;
      }
      const normalized = normalizeExternalApplyUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function detectApplyType(
  $: cheerio.CheerioAPI,
  applyUrl: string | null,
): "easy_apply" | "external" {
  if (applyUrl) {
    return "external";
  }

  const trackingSignals = $("[data-tracking-control-name]")
    .map((_i, el) => String($(el).attr("data-tracking-control-name") ?? ""))
    .get()
    .join(" ")
    .toLowerCase();

  const impressionSignals = $("[data-impression-id]")
    .map((_i, el) => String($(el).attr("data-impression-id") ?? ""))
    .get()
    .join(" ")
    .toLowerCase();

  if (trackingSignals.includes("public_jobs_apply-link-onsite")) {
    return "easy_apply";
  }

  if (
    trackingSignals.includes("public_jobs_apply-link-offsite") ||
    impressionSignals.includes("public_jobs_apply-link-offsite")
  ) {
    return "external";
  }

  const easyApplySelectors = [
    ".jobs-apply-button--top-card",
    "button.jobs-apply-button",
    "[data-is-easy-apply='true']",
    ".jobs-s-apply button",
  ];

  for (const selector of easyApplySelectors) {
    const el = $(selector);
    if (el.length > 0) {
      const text = el.text().toLowerCase();
      if (text.includes("easy apply")) {
        return "easy_apply";
      }
    }
  }

  const applyButtonText = normalizeWhitespace(
    $(
      "a.jobs-apply-button, button.jobs-apply-button, button[data-control-name*='apply'], a[data-control-name*='apply']",
    )
      .map((_i, el) => $(el).text())
      .get()
      .join(" "),
  ).toLowerCase();

  if (applyButtonText.includes("easy apply")) {
    return "easy_apply";
  }

  const bodyText = $("body").text().toLowerCase();
  if (bodyText.includes("easy apply") && !bodyText.includes("no longer accepting")) {
    return "easy_apply";
  }

  return "external";
}

function detectAtsPlatform(url: string): "workday" | "greenhouse" | "generic" {
  for (const candidate of ATS_PATTERNS) {
    if (candidate.pattern.test(url)) {
      return candidate.platform;
    }
  }

  return "generic";
}

function decodeUrlCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003A/gi, ":")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
