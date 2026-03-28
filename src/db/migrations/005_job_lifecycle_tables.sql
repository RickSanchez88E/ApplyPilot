-- Migration 005: Job lifecycle tables — unified truth layer
--
-- jobs_current  : canonical job record (single truth per job_key)
-- job_snapshots : content-change history (written only when content_hash differs)
-- crawl_runs    : per-command execution log
-- source_cursors: per-source pagination / progress state

-- ── job_status enum ─────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.job_availability_status AS ENUM (
    'active',
    'suspected_expired',
    'expired',
    'fetch_failed',
    'blocked'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── jobs_current ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.jobs_current (
  id              BIGSERIAL PRIMARY KEY,
  job_key         TEXT NOT NULL UNIQUE,   -- source:external_job_id or source:canonical_url_hash
  source          TEXT NOT NULL,
  external_job_id TEXT,
  canonical_url   TEXT,

  title           TEXT NOT NULL,
  company         TEXT NOT NULL,
  location        TEXT,
  work_mode       TEXT CHECK (work_mode IN ('remote', 'hybrid', 'onsite')),
  salary_text     TEXT,

  posted_at       TIMESTAMPTZ,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,

  job_status      public.job_availability_status NOT NULL DEFAULT 'active',
  consecutive_missing_count INT NOT NULL DEFAULT 0,

  content_hash    TEXT NOT NULL,
  last_evidence_type TEXT,
  last_evidence_at   TIMESTAMPTZ,

  apply_url       TEXT,
  ats_platform    TEXT,
  jd_raw          TEXT NOT NULL DEFAULT '',

  raw_last_payload JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_current_source     ON public.jobs_current (source);
CREATE INDEX IF NOT EXISTS idx_jobs_current_status     ON public.jobs_current (job_status);
CREATE INDEX IF NOT EXISTS idx_jobs_current_company    ON public.jobs_current (company);
CREATE INDEX IF NOT EXISTS idx_jobs_current_last_seen  ON public.jobs_current (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_current_content    ON public.jobs_current (content_hash);

-- ── job_snapshots ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  job_key     TEXT NOT NULL REFERENCES public.jobs_current(job_key) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  payload     JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_snapshots_job_key ON public.job_snapshots (job_key, captured_at DESC);

-- ── crawl_runs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crawl_runs (
  id              BIGSERIAL PRIMARY KEY,
  task_type       TEXT NOT NULL,   -- discover_jobs | verify_job | enrich_job | recheck_expiry
  source          TEXT NOT NULL,
  job_key         TEXT,            -- nullable for discover runs
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  http_status     INT,
  error_type      TEXT,
  retry_count     INT NOT NULL DEFAULT 0,
  evidence_summary TEXT,
  parser_version  TEXT,
  jobs_found      INT DEFAULT 0,
  jobs_inserted   INT DEFAULT 0,
  jobs_updated    INT DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INT
);

CREATE INDEX IF NOT EXISTS idx_crawl_runs_source  ON public.crawl_runs (source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_task    ON public.crawl_runs (task_type);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_job_key ON public.crawl_runs (job_key) WHERE job_key IS NOT NULL;

-- ── source_cursors ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.source_cursors (
  source            TEXT PRIMARY KEY,
  last_page         INT DEFAULT 0,
  last_cursor       TEXT,
  last_success_at   TIMESTAMPTZ,
  last_full_scan_at TIMESTAMPTZ,
  metadata          JSONB DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
