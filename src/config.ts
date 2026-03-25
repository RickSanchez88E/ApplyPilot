import "dotenv/config";

export interface Config {
  readonly databaseUrl: string;

  readonly linkedinLiAt: string;
  readonly linkedinJsessionId: string;

  readonly searchKeywords: string[];
  readonly searchLocation: string;
  readonly searchTimeFilter: string;
  readonly scrapeIntervalMs: number;

  readonly logLevel: string;
  readonly nodeEnv: string;
}

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
    searchTimeFilter: env("SEARCH_TIME_FILTER") ?? "r86400",
    scrapeIntervalMs: intEnv("SCRAPE_INTERVAL_MS", 1_800_000),

    logLevel: env("LOG_LEVEL") ?? "info",
    nodeEnv: env("NODE_ENV") ?? "development",
  };

  if (!cachedConfig.linkedinLiAt) {
    console.warn("[config] WARNING: LINKEDIN_LI_AT is empty — scraping will fail");
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
