import * as cheerio from "cheerio";
import { fetch } from "undici";
import { createChildLogger } from "../lib/logger.js";
import { fetchStealthHtml } from "./stealth-browser.js";
import type { NewJob } from "../shared/types.js";

const log = createChildLogger({ module: "ats-scraper" });

/**
 * Enhances a Job object with data crawled directly from the ATS page instead of relying purely on LinkedIn metadata.
 */
export async function enhanceJobWithAtsData(job: NewJob): Promise<NewJob> {
  if (!job.applyUrl || !job.atsPlatform || job.atsPlatform === "generic") {
    // We only process recognized ATS platforms. 
    return job;
  }

  log.debug({ platform: job.atsPlatform, url: job.applyUrl }, "Attempting direct ATS scrape");

  try {
    let html = "";
    // Route Phase 3 high-defense targets to Camoufox Stealth Browser
    if (["workday", "successfactors", "taleo", "icims"].includes(job.atsPlatform)) {
        html = await fetchStealthHtml(job.applyUrl, job.atsPlatform);
    } else {
        html = await fetchAtsHtml(job.applyUrl);
    }
    
    const $ = cheerio.load(html);
    let atsDescription = "";

    // Platform-specific DOM parsing heuristics
    switch (job.atsPlatform) {
      case "greenhouse":
        atsDescription = $("#content").text() || $("#main").text();
        break;
      case "lever":
        atsDescription = $(".content").text() || $(".posting-page").text();
        break;
      case "ashby":
        atsDescription = $(".ashby-job-posting-content, #job-description").text();
        break;
      case "workable":
        atsDescription = $("[data-ui='job-description']").text();
        break;
      case "breezyhr":
        atsDescription = $(".description, .job-description").text();
        break;
      case "smartrecruiters":
        atsDescription = $(".job-sections, [itemprop='description']").text();
        break;
      case "bamboohr":
        atsDescription = $(".ResAts__job-description, .job-description").text();
        break;
      case "taleo":
        atsDescription = $(".mastercontentpanel, .editablesection, .job-description").text();
        break;
      case "icims":
        // iCIMS often loads the job inside an iframe. The stealth browser captures outer frame usually, or inner frame.
        atsDescription = $(".iCIMS_JobContent, .iCIMS_MainWrapper").text();
        break;
      case "successfactors":
        atsDescription = $(".jobdescription, .job-description, .JD-container").text();
        break;
      case "workday":
        atsDescription = $('[data-automation-id="jobPostingDescription"]').text();
        break;
      default:
        return job;
    }

    atsDescription = cleanText(atsDescription);

    // Only overwrite if we found something useful
    if (atsDescription && atsDescription.length > 100) {
      log.info({ platform: job.atsPlatform, url: job.applyUrl }, "Successfully enhanced job with direct ATS data");
      return {
        ...job,
        jdRaw: atsDescription
      };
    }
  } catch (err) {
    log.warn({ err, platform: job.atsPlatform, url: job.applyUrl }, "Failed to fetch/parse ATS data, falling back to LinkedIn snapshot");
  }

  return job;
}

async function fetchAtsHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  
  // Phase 2 ATS sites (Greenhouse, Lever, Ashby, etc.) are public job pages
  // with no anti-bot protection — NO proxy needed, saves Webshare tokens.
  // Only Phase 3 (Workday, iCIMS, Taleo, SuccessFactors) routes through
  // Camoufox stealth browser + residential proxy in stealth-browser.ts.
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5"
  };

  log.debug({ url: url.slice(0, 80), proxy: false }, "Fetching Phase 2 ATS page (no proxy)");

  const response = await fetch(url, { 
    signal: controller.signal, 
    headers,
    redirect: "follow"
  } as any);
  
  clearTimeout(timeoutId);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  return await response.text();
}

function cleanText(raw: string): string {
  // Strip excessive whitespace, keep reasonable formatting
  return raw.replace(/\s+/g, " ").trim();
}
