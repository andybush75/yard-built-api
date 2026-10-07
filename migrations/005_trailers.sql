-- Migration 005: trailer utilization tracker + app settings
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Small key/value store for app-wide settings an admin changes from Settings (never code).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id)
);
INSERT INTO app_settings (key, value) VALUES
  ('trailer_loads_goal_per_week', '5'),
  ('trailer_tons_target_by_type', '{"End dump": 60, "Gondola": 100, "Flatbed": 100, "Van": 100, "Railcar": 100, "Other": 100}'),
  ('trailer_default_tons_target', '100')
ON CONFLICT (key) DO NOTHING;

-- Every trailer, rail car pool or carrier-trailer pool Langer wants to watch. "Owned" trailers are
-- Langer's; a non-owned record is a bucket (e.g. "Rail cars") so those loads still count somewhere.
CREATE TABLE IF NOT EXISTS trailers (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  number                TEXT UNIQUE NOT NULL,          -- "201", or a bucket label like "Rail cars"
  yard                  TEXT NOT NULL,                 -- home yard: SB | HAYS | COLBY | RC
  type                  TEXT NOT NULL DEFAULT 'Gondola', -- End dump | Gondola | Flatbed | Van | Railcar | Other
  carrier_id            TEXT REFERENCES carriers(id),  -- who is currently pulling it (null = Langer / unassigned)
  owned                 BOOLEAN NOT NULL DEFAULT true,
  target_tons_per_week  INTEGER,                       -- null = use the type default from app_settings
  active                BOOLEAN NOT NULL DEFAULT true,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which trailer hauled this ticket's load. Outbound = sell tickets, inbound = buy tickets.
-- A shipment of several tickets on one trailer counts as one load.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trailer_id TEXT REFERENCES trailers(id);
CREATE INDEX IF NOT EXISTS idx_tickets_trailer_date ON tickets(trailer_id, date);

-- Weekly history imported from the old TMS sheet (Sun–Sat weeks). The utilization report uses a
-- ticket-computed week when one has any ticket on that trailer, else the imported week.
CREATE TABLE IF NOT EXISTS trailer_week_history (
  trailer_id  TEXT NOT NULL REFERENCES trailers(id),
  week_start  DATE NOT NULL,                        -- the Sunday
  out_loads   NUMERIC(8,1) NOT NULL DEFAULT 0,
  out_tons    NUMERIC(10,1) NOT NULL DEFAULT 0,
  in_loads    NUMERIC(8,1) NOT NULL DEFAULT 0,
  in_tons     NUMERIC(10,1) NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'tms_sheet',
  PRIMARY KEY (trailer_id, week_start)
);
