-- Migration 006: Apply discovery results + source schedule state
--
-- apply_discovery_results : per-job apply link resolution tracking
-- source_schedule_state   : per-source scheduling, lease, and cooldown state

-- ── apply_discovery_status enum ─────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.apply_discovery_status AS ENUM (
    'unresolved',
    'platform_desc_only',
    'intermediate_redirect',
    'requires_login',
    'requires_registration',
    'oauth_google',
    'oauth_linkedin',
    'final_form_reached',
    'blocked',
    'unsupported',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── apply_discovery_results ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.apply_discovery_results (
  id                      BIGSERIAL PRIMARY KEY,
  job_key                 TEXT NOT NULL,
  source                  TEXT NOT NULL,
  apply_discovery_status  public.apply_discovery_status NOT NULL DEFAULT 'unresolved',

  source_desc_url         TEXT,
  initial_apply_url       TEXT,
  resolved_apply_url      TEXT,
  final_form_url          TEXT,

  redirect_chain          JSONB DEFAULT '[]'::jsonb,

  login_required          BOOLEAN NOT NULL DEFAULT FALSE,
  registration_required   BOOLEAN NOT NULL DEFAULT FALSE,
  oauth_provider          TEXT,

  final_form_reached_at   TIMESTAMPTZ,
  form_schema_snapshot    JSONB,
  form_provider           TEXT,

  last_resolution_error   TEXT,
  resolver_version        TEXT NOT NULL DEFAULT '1.0',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_apply_discovery_job_key UNIQUE (job_key)
);

CREATE INDEX IF NOT EXISTS idx_apply_disc_source ON public.apply_discovery_results (source);
CREATE INDEX IF NOT EXISTS idx_apply_disc_status ON public.apply_discovery_results (apply_discovery_status);
CREATE INDEX IF NOT EXISTS idx_apply_disc_form_reached ON public.apply_discovery_results (final_form_reached_at DESC)
  WHERE apply_discovery_status = 'final_form_reached';

-- ── source_schedule_state ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.source_schedule_state (
  source              TEXT PRIMARY KEY,
  interval_ms         INT NOT NULL,
  last_dispatched_at  TIMESTAMPTZ,
  next_dispatch_at    TIMESTAMPTZ,

  lease_holder        TEXT,
  lease_acquired_at   TIMESTAMPTZ,
  lease_expires_at    TIMESTAMPTZ,

  cooldown_until      TIMESTAMPTZ,
  cooldown_reason     TEXT,

  consecutive_failures INT NOT NULL DEFAULT 0,
  last_failure_at     TIMESTAMPTZ,

  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default schedule intervals
INSERT INTO public.source_schedule_state (source, interval_ms) VALUES
  ('linkedin',  1200000),
  ('reed',      1800000),
  ('remoteok',  3600000),
  ('devitjobs', 7200000),
  ('hn_hiring', 21600000),
  ('jooble',    14400000)
ON CONFLICT (source) DO NOTHING;
