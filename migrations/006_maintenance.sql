-- Migration 006: maintenance — assets, PM schedules, work orders, inspections, notifications
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Equipment and trucks. The id is the fleet number people already use ("E10", "205").
CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  yard         TEXT NOT NULL,
  year         INTEGER,
  make         TEXT,
  model        TEXT,
  type         TEXT NOT NULL,                   -- Excavator | Material Handler | Skid Steer | Forklift | Truck Tractor | Roll-Off Truck | ...
  meter_type   TEXT NOT NULL DEFAULT 'Hours',   -- Hours | Miles
  meter        NUMERIC(12,1) NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'up',      -- up | down
  custom_items JSONB NOT NULL DEFAULT '[]',     -- extra checklist items for this one unit
  notes        TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pm_schedules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  asset_id        TEXT NOT NULL REFERENCES assets(id),
  name            TEXT NOT NULL,
  trigger         TEXT NOT NULL,                -- meter | calendar
  interval        INTEGER NOT NULL,             -- hours/miles, or days
  last_done_meter NUMERIC(12,1),
  last_done_date  DATE,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Work order numbers continue the prototype's LIS.<yard>.<FP|TRAN>.<n> pattern.
CREATE SEQUENCE IF NOT EXISTS work_order_seq START WITH 1211;

CREATE TABLE IF NOT EXISTS work_orders (
  id                 TEXT PRIMARY KEY,
  asset_id           TEXT NOT NULL REFERENCES assets(id),
  yard               TEXT NOT NULL,
  title              TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 3,      -- 1 (low) .. 5 (urgent)
  status             TEXT NOT NULL DEFAULT 'unassigned', -- unassigned | not_started | in_progress | waiting | review | complete
  assignee_id        TEXT REFERENCES users(id),
  issued_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  meter_at_issue     NUMERIC(12,1),
  from_pm_id         TEXT REFERENCES pm_schedules(id),
  from_inspection_id TEXT,
  items              JSONB,                            -- failed inspection items this WO covers
  shop_name          TEXT,
  invoice_amount     NUMERIC(12,2),
  invoice_file_name  TEXT,
  invoice_data_url   TEXT,                             -- small image/PDF as a data URL (capped by the API)
  completed_at       TIMESTAMPTZ,
  completed_by       TEXT REFERENCES users(id),
  notes              TEXT,
  created_by         TEXT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_orders_yard_status ON work_orders(yard, status);
CREATE INDEX IF NOT EXISTS idx_work_orders_assignee ON work_orders(assignee_id) WHERE status <> 'complete';

CREATE SEQUENCE IF NOT EXISTS inspection_seq START WITH 4;

CREATE TABLE IF NOT EXISTS inspections (
  id                   TEXT PRIMARY KEY,               -- INS-<n>
  asset_id             TEXT NOT NULL REFERENCES assets(id),
  yard                 TEXT NOT NULL,
  date                 DATE NOT NULL,
  meter_value          NUMERIC(12,1),
  service              TEXT NOT NULL DEFAULT 'Daily',
  type                 TEXT NOT NULL DEFAULT 'Pre-Shift',
  completed_by         TEXT,                            -- name as entered (operators may not have logins)
  completed_by_user_id TEXT REFERENCES users(id),
  results              JSONB NOT NULL,                  -- [{category, item, pass, note}]
  score                NUMERIC(5,1) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inspections_asset_date ON inspections(asset_id, date DESC);

-- Per-user inbox (the bell in the top bar). First use: work order assignments.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,                  -- work_order_assigned | ...
  message    TEXT NOT NULL,
  ref_type   TEXT,
  ref_id     TEXT,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);
