-- Migration 015: Box Dispatch (roll-offs, luggers, hoppers, totes) — the real box inventory plus a
-- log of every drop / pick-up / swap a driver or the office records.
-- Applied once, in order, inside a transaction. Never edit after it has run anywhere — add a new file.

-- One row per physical container Langer owns (or believes it owns). Where it is right now lives here;
-- how it got there lives in box_moves.
CREATE TABLE IF NOT EXISTS boxes (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  number          TEXT UNIQUE NOT NULL,                 -- as painted on the box: "30-11", "M97", "L67", "SD04"
  kind            TEXT NOT NULL DEFAULT 'Roll-off',     -- Roll-off | Lugger | Hopper | Tote | Tire box | Other
  size            TEXT,                                 -- "20 yd", "30 yd" … (free text, luggers often blank)
  style           TEXT,                                 -- IR / OR (inside / outside rail) or other build note
  home_yard       TEXT NOT NULL DEFAULT 'SB',           -- yard the box belongs to: SB | HAYS | COLBY | RC
  status          TEXT NOT NULL DEFAULT 'yard',         -- yard | customer | repair | missing | retired
  current_yard    TEXT,                                 -- yard it sits at (status yard) or serves from (status customer)
  customer_name   TEXT,                                 -- who has it, when status = customer
  vendor_id       TEXT REFERENCES vendors(id),          -- optional link to the dealer/vendor record
  site            TEXT,                                 -- street / site description at the customer
  placed_at       TIMESTAMPTZ,                          -- when it landed at the current customer (box-rent clock)
  last_moved_at   TIMESTAMPTZ,
  last_move_id    TEXT,
  -- What the two old systems said when the box list was built (kept for the reconciliation report).
  sd_container_id TEXT,
  sd_snapshot     JSONB,
  qb_account      TEXT,
  qb_book_value   NUMERIC(12,2),
  -- Beta: office confirms each box against the paper count; anything odd is flagged for review.
  needs_review    BOOLEAN NOT NULL DEFAULT false,
  review_note     TEXT,
  verified_at     TIMESTAMPTZ,
  verified_by     TEXT REFERENCES users(id),
  active          BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_boxes_status ON boxes(status, current_yard);
CREATE INDEX IF NOT EXISTS idx_boxes_customer ON boxes(lower(customer_name));

-- Every box event. A swap is one row with both box_in (dropped at the customer) and box_out (picked up).
-- prev_in / prev_out snapshot the boxes' location before this move so the office can undo (void) it.
CREATE TABLE IF NOT EXISTS box_moves (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  action          TEXT NOT NULL,                        -- drop | pickup | swap | yard_move | status | correction
  yard            TEXT,
  customer_name   TEXT,
  vendor_id       TEXT REFERENCES vendors(id),
  site            TEXT,
  box_in_id       TEXT REFERENCES boxes(id),
  box_out_id      TEXT REFERENCES boxes(id),
  box_in_number   TEXT,                                 -- exactly as the driver typed it
  box_out_number  TEXT,
  new_status      TEXT,                                 -- for action = status (repair / missing / retired / yard)
  truck           TEXT,
  driver_name     TEXT,
  user_id         TEXT REFERENCES users(id),
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),
  accuracy_m      INTEGER,
  photo           TEXT,                                 -- small JPEG data URL, optional
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'driver',       -- driver | office | import
  client_id       TEXT UNIQUE,                          -- phone-generated id so a retried send never posts twice
  warnings        TEXT[],                               -- what didn't line up when it was posted (box was elsewhere, unknown #)
  prev_in         JSONB,
  prev_out        JSONB,
  voided_at       TIMESTAMPTZ,
  voided_by       TEXT REFERENCES users(id),
  void_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_box_moves_time ON box_moves(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_box_moves_in ON box_moves(box_in_id);
CREATE INDEX IF NOT EXISTS idx_box_moves_out ON box_moves(box_out_id);

-- Drivers sign in to the phone page only; they need no other permission. Office staff who fix boxes
-- (edit, void a driver's entry, mark verified) need manageBoxes.
INSERT INTO roles (name, system, permissions) VALUES ('Driver', false, '{}') ON CONFLICT (name) DO NOTHING;
UPDATE roles SET permissions = permissions || '{manageBoxes}'
  WHERE name IN ('Admin', 'Yard Manager') AND NOT (permissions @> '{manageBoxes}');
