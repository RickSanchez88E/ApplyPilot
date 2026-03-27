/**
 * Persistent scraper config — keywords & location stored in PostgreSQL.
 *
 * Table: public.scraper_config (key TEXT PK, value JSONB, updated_at TIMESTAMPTZ)
 * Keys: 'keywords' → string[], 'location' → string
 */
import { query } from "./client.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "config-db" });

export interface ScraperConfig {
  keywords: string[];
  location: string;
}

/** Get config from DB, fallback to .env defaults */
export async function getScraperConfig(): Promise<ScraperConfig> {
  try {
    const result = await query<{ key: string; value: unknown }>(
      "SELECT key, value FROM public.scraper_config WHERE key IN ('keywords', 'location')",
    );
    let keywords: string[] = (process.env.SEARCH_KEYWORDS ?? "software engineer").split(",").map(s => s.trim());
    let location = process.env.SEARCH_LOCATION ?? "London, United Kingdom";

    for (const row of result.rows) {
      if (row.key === "keywords" && Array.isArray(row.value)) {
        keywords = row.value as string[];
      }
      if (row.key === "location" && typeof row.value === "string") {
        location = row.value;
      }
    }

    return { keywords, location };
  } catch (err) {
    log.warn({ err }, "Failed to read config from DB, using .env defaults");
    return {
      keywords: (process.env.SEARCH_KEYWORDS ?? "software engineer").split(",").map(s => s.trim()),
      location: process.env.SEARCH_LOCATION ?? "London, United Kingdom",
    };
  }
}

/** Save keywords to DB */
export async function setScraperKeywords(keywords: string[]): Promise<void> {
  await query(
    `INSERT INTO public.scraper_config (key, value, updated_at)
     VALUES ('keywords', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify(keywords)],
  );
  log.info({ keywords }, "Keywords saved to DB");
}

/** Save location to DB */
export async function setScraperLocation(location: string): Promise<void> {
  await query(
    `INSERT INTO public.scraper_config (key, value, updated_at)
     VALUES ('location', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify(location)],
  );
  log.info({ location }, "Location saved to DB");
}
