# LinkedIn Job Scraper

Condition-triggered LinkedIn job scraper that fetches job listings via the Guest Jobs API and stores them in PostgreSQL with SHA-256 URL dedup.

## Features

- **Guest API scraping** — uses LinkedIn's public job search API (no headless browser needed for most jobs)
- **Playwright fallback** — dynamic import for JS-rendered pages when the guest API fails
- **SHA-256 dedup** — `ON CONFLICT (url_hash) DO NOTHING` ensures idempotent inserts
- **Session management** — cookie-based auth with health checks and expiry detection
- **ATS detection** — identifies Workday, Greenhouse, and generic external apply links
- **Retry with backoff** — exponential backoff + jitter on transient failures
- **Condition-triggered batches** — runs when all jobs are resolved or on manual trigger

## Quick Start

```bash
# 1. Start Postgres
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Copy env and fill in your LinkedIn cookies
cp .env.example .env

# 4. Run migrations
pnpm migrate

# 5. Trigger a scrape batch
pnpm trigger:force
```

## How to Get LinkedIn Cookies

1. Log into LinkedIn in your browser
2. Open DevTools → Application → Cookies → `linkedin.com`
3. Copy `li_at` and `JSESSIONID` values into `.env`

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm trigger` | Run scrape batch (respects trigger conditions) |
| `pnpm trigger:force` | Force run regardless of conditions |
| `pnpm migrate` | Run database migrations |
| `pnpm dev` | Run with file watcher |
| `pnpm test` | Run tests |
| `pnpm build` | Compile TypeScript |

## Architecture

```
src/
├── index.ts              # Main entry — batch orchestration
├── linkedin-scraper.ts   # HTTP fetch + pagination
├── job-parser.ts         # HTML/JSON → NewJob (cheerio)
├── linkedin-job-detail.ts# Job detail page parser
├── dedup.ts              # SHA-256 dedup + DB insert
├── session-manager.ts    # Cookie auth + health check
├── config.ts             # Environment config
├── types.ts              # TypeScript interfaces
├── errors.ts             # Custom error classes
├── utils.ts              # hashUrl, sleep, retry
├── logger.ts             # Pino structured logging
└── db/
    ├── client.ts         # PG connection pool
    ├── migrate.ts        # Migration runner
    └── migrations/
        └── 001_create_jobs.sql
```

## Trigger Conditions

A scrape batch runs when **any** of these conditions are met:

1. **Manual** — CLI with `--force` flag
2. **Queue drained** — all existing jobs in terminal states (`applied`, `ignored`, `suspended`)
3. **Project init** — no jobs in database yet

## License

MIT
