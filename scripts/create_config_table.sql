CREATE TABLE IF NOT EXISTS public.scraper_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.scraper_config (key, value) VALUES
  ('keywords', '["software engineer", "backend engineer", "security engineer"]'::jsonb),
  ('location', '"London, United Kingdom"'::jsonb)
ON CONFLICT (key) DO NOTHING;
