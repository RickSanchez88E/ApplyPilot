/**
 * GOV.UK Visa Sponsor List — Free CSV download, daily updated.
 * 124,735 licensed sponsor companies.
 * This adapter downloads the CSV and imports company names for cross-referencing.
 */
import { query } from "../db/client.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-govuk-sponsor" });

// The GOV.UK sponsor register CSV URL (redirects to actual file)
const SPONSOR_CSV_URL =
  "https://assets.publishing.service.gov.uk/media/6613de0f3e4d0f0711ff5207/2024-04-08_-_Worker_and_Temporary_Worker.csv";

/**
 * Downloads the GOV.UK Licensed Sponsors CSV and updates the can_sponsor flag
 * on all matching jobs in the database.
 */
export async function syncSponsorList(): Promise<{ totalSponsors: number; jobsUpdated: number }> {
  log.info("Downloading GOV.UK Licensed Sponsors register...");

  try {
    const res = await fetch(SPONSOR_CSV_URL, {
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });

    if (!res.ok) {
      log.error({ status: res.status }, "Failed to download sponsor CSV");
      return { totalSponsors: 0, jobsUpdated: 0 };
    }

    const csvText = await res.text();
    const lines = csvText.split("\n").slice(1); // Skip header

    // Parse company names (first column in CSV)
    const sponsorNames = new Set<string>();
    for (const line of lines) {
      // CSV format: "Organisation Name","Town/City","County","Type & Rating","Route"
      const match = line.match(/^"?([^",]+)"?/);
      if (match?.[1]) {
        sponsorNames.add(match[1].trim().toLowerCase());
      }
    }

    log.info({ totalSponsors: sponsorNames.size }, "Parsed sponsor list");

    // Update all jobs: set can_sponsor = true where company name matches
    // Use case-insensitive matching with LOWER()
    const result = await query(
      `UPDATE jobs SET can_sponsor = TRUE
       WHERE LOWER(company_name) IN (
         SELECT UNNEST($1::text[])
       ) AND can_sponsor = FALSE`,
      [Array.from(sponsorNames)],
    );

    const jobsUpdated = result.rowCount ?? 0;
    log.info({ totalSponsors: sponsorNames.size, jobsUpdated }, "Sponsor list sync complete");

    return { totalSponsors: sponsorNames.size, jobsUpdated };
  } catch (err) {
    log.error({ err }, "Sponsor list sync failed");
    return { totalSponsors: 0, jobsUpdated: 0 };
  }
}
