-- Migration 016: Box jobs — the call-in requests that feed the drivers' boards.
-- A customer calls for a swap / drop / pick-up; the scale operator logs it here and puts it on a
-- driver's board. The driver completes it from the phone page, which posts a box move (box_moves) and
-- closes the job in the same transaction. Applied once, in order, inside a transaction. Never edit
-- after it has run anywhere — add a new file.

CREATE SEQUENCE IF NOT EXISTS box_job_seq START 1001;

CREATE TABLE IF NOT EXISTS box_jobs (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_no           INTEGER UNIQUE NOT NULL DEFAULT nextval('box_job_seq'),   -- shown as J-1001
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT REFERENCES users(id),
  yard             TEXT NOT NULL,                       -- yard dispatching it: SB | HAYS | COLBY | RC
  task             TEXT NOT NULL,                       -- swap | drop | pickup | dump_return | other
  customer_name    TEXT NOT NULL,
  vendor_id        TEXT REFERENCES vendors(id),         -- optional link to the dealer record
  site             TEXT,                                -- street / site description
  contact_name     TEXT,
  contact_phone    TEXT,
  box_kind         TEXT,                                -- Roll-off | Lugger | … (what the customer has / needs)
  box_size         TEXT,                                -- "30 yd" …
  box_number       TEXT,                                -- the box at the site, when known (swap / pick-up)
  requested_for    DATE,                                -- day the customer wants it (null = as soon as possible)
  priority         TEXT NOT NULL DEFAULT 'normal',      -- normal | urgent
  driver_id        TEXT REFERENCES users(id),           -- whose board it's on (null = unassigned)
  board_order      INTEGER NOT NULL DEFAULT 0,          -- order on that driver's board
  status           TEXT NOT NULL DEFAULT 'open',        -- open | assigned | started | done | cancelled
  office_notes     TEXT,                                -- what the driver should know
  driver_notes     TEXT,                                -- what the driver said when finishing
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  completed_by     TEXT REFERENCES users(id),
  move_id          TEXT REFERENCES box_moves(id),       -- the drop / pick-up / swap that finished it
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     TEXT REFERENCES users(id),
  cancel_reason    TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_box_jobs_board ON box_jobs(status, driver_id, board_order);
CREATE INDEX IF NOT EXISTS idx_box_jobs_yard ON box_jobs(yard, status);

ALTER TABLE box_moves ADD COLUMN IF NOT EXISTS job_id TEXT REFERENCES box_jobs(id);

-- Taking a call and putting it on a driver's board. Scale operators and cashiers answer the phone,
-- so they get it along with Admin and Yard Manager.
UPDATE roles SET permissions = permissions || '{dispatchBoxes}'
  WHERE name IN ('Admin', 'Yard Manager', 'Cashier', 'Scale Operator') AND NOT (permissions @> '{dispatchBoxes}');
