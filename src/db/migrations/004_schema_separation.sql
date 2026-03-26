-- Migration 004: Schema-based data separation
-- Each source gets its own schema with identical jobs table structure.
-- A public.jobs_all VIEW unions them for cross-source queries.

-- ── Create schemas ───────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS src_linkedin;
CREATE SCHEMA IF NOT EXISTS src_devitjobs;
CREATE SCHEMA IF NOT EXISTS src_reed;
CREATE SCHEMA IF NOT EXISTS src_jooble;
CREATE SCHEMA IF NOT EXISTS src_hn_hiring;
CREATE SCHEMA IF NOT EXISTS src_remoteok;

-- ── Job state enum for each schema ───────────────────────────
-- (We reuse the public enum since it's accessible across schemas)

-- ── Generic per-schema jobs table creator (via DO block) ─────
DO $$
DECLARE
  schemas TEXT[] := ARRAY['src_linkedin','src_devitjobs','src_reed','src_jooble','src_hn_hiring','src_remoteok'];
  s TEXT;
BEGIN
  FOREACH s IN ARRAY schemas LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.jobs (
        id BIGSERIAL PRIMARY KEY,
        linkedin_url TEXT,
        url_hash TEXT NOT NULL UNIQUE,
        company_name TEXT NOT NULL,
        job_title TEXT NOT NULL,
        location TEXT,
        work_mode TEXT CHECK (work_mode IN (''remote'', ''hybrid'', ''onsite'')),
        salary_text TEXT,
        posted_date TIMESTAMPTZ,
        jd_raw TEXT NOT NULL DEFAULT '''',
        jd_structured JSONB,
        apply_type TEXT CHECK (apply_type IN (''easy_apply'', ''external'')),
        apply_url TEXT,
        ats_platform TEXT,
        state TEXT NOT NULL DEFAULT ''pending'' CHECK (state IN (''pending'', ''applied'', ''processing'', ''ignored'', ''suspended'')),
        state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        generated_cv_id BIGINT,
        last_error TEXT,
        retry_count INT NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        source_url TEXT,
        content_hash TEXT,
        can_sponsor BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )', s);

    -- Indexes per schema
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_jobs_state ON %I.jobs (state)', replace(s, 'src_', ''), s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_jobs_content_hash ON %I.jobs (content_hash)', replace(s, 'src_', ''), s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_jobs_posted_date ON %I.jobs (posted_date DESC NULLS LAST)', replace(s, 'src_', ''), s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_jobs_company ON %I.jobs (company_name)', replace(s, 'src_', ''), s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_jobs_created_at ON %I.jobs (created_at DESC)', replace(s, 'src_', ''), s);
  END LOOP;
END
$$;

-- ── Migrate existing data from public.jobs to src_linkedin ───
INSERT INTO src_linkedin.jobs (
  id, linkedin_url, url_hash, company_name, job_title, location,
  work_mode, salary_text, posted_date, jd_raw, jd_structured,
  apply_type, apply_url, ats_platform, state, state_changed_at,
  generated_cv_id, last_error, retry_count, source, source_url,
  content_hash, can_sponsor, created_at, updated_at
)
SELECT
  id, linkedin_url, url_hash, company_name, job_title, location,
  work_mode, salary_text, posted_date, jd_raw, jd_structured,
  apply_type, apply_url, ats_platform, state, state_changed_at,
  generated_cv_id, last_error, retry_count, source, source_url,
  content_hash, can_sponsor, created_at, updated_at
FROM public.jobs
WHERE source = 'linkedin'
ON CONFLICT (url_hash) DO NOTHING;

-- Migrate any non-linkedin data to their respective schemas
DO $$
DECLARE
  source_map RECORD;
BEGIN
  FOR source_map IN
    SELECT DISTINCT source FROM public.jobs WHERE source != 'linkedin'
  LOOP
    EXECUTE format(
      'INSERT INTO src_%s.jobs (
        linkedin_url, url_hash, company_name, job_title, location,
        work_mode, salary_text, posted_date, jd_raw, jd_structured,
        apply_type, apply_url, ats_platform, state, state_changed_at,
        generated_cv_id, last_error, retry_count, source, source_url,
        content_hash, can_sponsor, created_at, updated_at
      )
      SELECT
        linkedin_url, url_hash, company_name, job_title, location,
        work_mode, salary_text, posted_date, jd_raw, jd_structured,
        apply_type, apply_url, ats_platform, state, state_changed_at,
        generated_cv_id, last_error, retry_count, source, source_url,
        content_hash, can_sponsor, created_at, updated_at
      FROM public.jobs
      WHERE source = %L
      ON CONFLICT (url_hash) DO NOTHING',
      source_map.source, source_map.source
    );
  END LOOP;
END
$$;

-- ── Cross-platform content index ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_index (
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  source_job_id BIGINT NOT NULL,
  source_url TEXT,
  company_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_hash, source)
);

CREATE INDEX IF NOT EXISTS idx_content_index_hash ON public.content_index (content_hash);

-- ── Create unified VIEW ──────────────────────────────────────
CREATE OR REPLACE VIEW public.jobs_all AS
  SELECT *, 'linkedin' AS _schema FROM src_linkedin.jobs
  UNION ALL
  SELECT *, 'devitjobs' AS _schema FROM src_devitjobs.jobs
  UNION ALL
  SELECT *, 'reed' AS _schema FROM src_reed.jobs
  UNION ALL
  SELECT *, 'jooble' AS _schema FROM src_jooble.jobs
  UNION ALL
  SELECT *, 'hn_hiring' AS _schema FROM src_hn_hiring.jobs
  UNION ALL
  SELECT *, 'remoteok' AS _schema FROM src_remoteok.jobs;

-- ── Sequence reset for src_linkedin ──────────────────────────
SELECT setval('src_linkedin.jobs_id_seq', COALESCE((SELECT MAX(id) FROM src_linkedin.jobs), 0) + 1, false);
