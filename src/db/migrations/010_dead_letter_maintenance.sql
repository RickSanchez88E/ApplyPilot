CREATE TABLE IF NOT EXISTS public.dead_letter_records (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_schema TEXT NOT NULL,
  source_job_id BIGINT NOT NULL,
  title TEXT,
  url TEXT,
  reason TEXT NOT NULL,
  payload JSONB,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_records_purge_after
  ON public.dead_letter_records (purge_after);

CREATE TABLE IF NOT EXISTS public.maintenance_jobs (
  job_name TEXT PRIMARY KEY,
  interval_ms INTEGER NOT NULL DEFAULT 21600000,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_next_run_at
  ON public.maintenance_jobs (next_run_at);
