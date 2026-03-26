-- Migration 003: Multi-source support + cross-platform dedup + visa sponsor flag
-- Adds source tracking, content-based fingerprinting, and sponsor status

-- Column: source — which platform/data source this job came from
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'linkedin';

-- Column: source_url — the canonical URL on the source platform (may differ from linkedin_url)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_url TEXT;

-- Column: content_hash — SHA-256(normalize(company) + "|" + normalize(title))
-- Used for cross-platform dedup: same company + same title = same job across platforms
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Column: can_sponsor — whether the company is on GOV.UK Licensed Sponsors list
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS can_sponsor BOOLEAN DEFAULT FALSE;

-- Rename linkedin_url to be more generic (keep old name as alias)
-- We won't rename the column to avoid breaking existing code, but make it nullable for non-LinkedIn sources
ALTER TABLE jobs ALTER COLUMN linkedin_url DROP NOT NULL;

-- Indexes for multi-source queries
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs (source);
CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs (content_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_can_sponsor ON jobs (can_sponsor) WHERE can_sponsor = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_source_state ON jobs (source, state);
