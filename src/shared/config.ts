import "dotenv/config";

export interface Config {
  readonly databaseUrl: string;

  readonly linkedinLiAt: string;
  readonly linkedinJsessionId: string;

  readonly searchKeywords: string[];
  readonly searchLocation: string;
  readonly searchTimeFilter: string;        // primary filter (default: r3600)
  readonly searchTimeFilters: string[];     // multi-pass: ["r3600", "r86400"]
  readonly scrapeIntervalMs: number;
  readonly webshareProxyUrl: string;
  readonly webshareApiKey: string;

  readonly camoufoxPath: string;
  readonly browserHeadless: boolean;

  /** Which sources are enabled (if not set, all are enabled) */
  readonly enabledSources: string[];

  readonly logLevel: string;
  readonly nodeEnv: string;
}

/** LinkedIn time filter presets */
export const TIME_FILTER_PRESETS: Record<string, { label: string; value: string }> = {
  "1h": { label: "Past 1 hour", value: "r3600" },
  "6h": { label: "Past 6 hours", value: "r21600" },
  "24h": { label: "Past 24 hours", value: "r86400" },
  "1w": { label: "Past week", value: "r604800" },
  "1m": { label: "Past month", value: "r2592000" },
};

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    databaseUrl:
      env("DATABASE_URL") ?? "postgres://orchestrator:orchestrator@localhost:5432/job_orchestrator",
    linkedinLiAt: env("LINKEDIN_LI_AT") ?? "",
    linkedinJsessionId: env("LINKEDIN_JSESSIONID") ?? "",

    searchKeywords: (env("SEARCH_KEYWORDS") ?? "software engineer").split(",").map((s) => s.trim()),
    searchLocation: env("SEARCH_LOCATION") ?? "London, United Kingdom",
    searchTimeFilter: env("SEARCH_TIME_FILTER") ?? "r3600",
    searchTimeFilters: (env("SEARCH_TIME_FILTERS") ?? "r3600,r86400").split(",").map((s) => s.trim()),
    scrapeIntervalMs: intEnv("SCRAPE_INTERVAL_MS", 1_800_000),
    webshareProxyUrl: env("WEBSHARE_PROXY_URL") ?? "",
    webshareApiKey: env("WEBSHARE_API_KEY") ?? "",

    camoufoxPath: env("CAMOUFOX_PATH") ?? "",
    browserHeadless: env("BROWSER_HEADLESS") !== "false",

    enabledSources: (env("ENABLED_SOURCES") ?? "linkedin,devitjobs,reed,jooble,hn_hiring,remoteok")
      .split(",").map((s) => s.trim()),

    logLevel: env("LOG_LEVEL") ?? "info",
    nodeEnv: env("NODE_ENV") ?? "development",
  };

  if (!cachedConfig.linkedinLiAt) {
    console.warn("[config] WARNING: LINKEDIN_LI_AT is empty — LinkedIn scraping will fail");
  }

  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}

function env(key: string): string | undefined {
  return process.env[key];
}

function intEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const parsed = Number.parseInt(v, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
