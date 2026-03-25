-- Core jobs table with state machine
CREATE TYPE job_state AS ENUM ('pending', 'applied', 'processing', 'ignored');

CREATE TABLE jobs (
    id              BIGSERIAL PRIMARY KEY,
    -- Idempotent dedup
    linkedin_url    TEXT NOT NULL,
    url_hash        TEXT NOT NULL,
    -- Core fields
    company_name    TEXT NOT NULL,
    job_title       TEXT NOT NULL,
    location        TEXT,
    work_mode       TEXT,
    salary_text     TEXT,
    posted_date     TIMESTAMPTZ,
    jd_raw          TEXT NOT NULL,
    jd_structured   JSONB,
    -- Apply routing
    apply_type      TEXT,
    apply_url       TEXT,
    ats_platform    TEXT,
    -- State machine
    state           job_state NOT NULL DEFAULT 'pending',
    state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_cv_id BIGINT,
    -- Error tracking
    last_error      TEXT,
    retry_count     INT NOT NULL DEFAULT 0,
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_url_hash UNIQUE (url_hash)
);

CREATE INDEX idx_jobs_state ON jobs (state);
CREATE INDEX idx_jobs_state_apply ON jobs (state, apply_type) WHERE state = 'pending';
CREATE INDEX idx_jobs_created ON jobs (created_at DESC);
