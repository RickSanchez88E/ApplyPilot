-- Migration 007: Persist apply discovery resolution back to jobs_current
--
-- Adds apply resolution status/url fields to the canonical job table so
-- downstream reads do not need to join apply_discovery_results every time.

ALTER TABLE public.jobs_current
  ADD COLUMN IF NOT EXISTS apply_resolution_status public.apply_discovery_status,
  ADD COLUMN IF NOT EXISTS apply_resolution_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS apply_resolution_error TEXT,
  ADD COLUMN IF NOT EXISTS final_apply_url TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_current_apply_resolution_status
  ON public.jobs_current (apply_resolution_status);

CREATE INDEX IF NOT EXISTS idx_jobs_current_final_apply_url
  ON public.jobs_current (final_apply_url)
  WHERE final_apply_url IS NOT NULL;
