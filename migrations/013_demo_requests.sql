-- Migration 013: demo requests from the public yardbuilt.net site.
CREATE TABLE IF NOT EXISTS demo_requests (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name             TEXT NOT NULL,
  company          TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  yards            TEXT,
  current_software TEXT,
  message          TEXT,
  ip               TEXT,
  user_agent       TEXT,
  status           TEXT NOT NULL DEFAULT 'new',   -- new | contacted | closed
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ,
  updated_by       TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_demo_requests_created ON demo_requests(created_at DESC);
