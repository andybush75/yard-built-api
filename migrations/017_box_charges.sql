-- Migration 017: Box charges — box rent and truck mileage, deducted on the customer's buy ticket.
-- Rent is figured when a box leaves the customer (pick-up or swap): days on site from the drop,
-- minus the free days, at the weekly rate prorated by the day. Mileage is figured from the truck's
-- Motive odometer between the driver starting the job and the truck crossing the scale.
-- Both land as pending charges for that customer; the scale operator sees them on the purchase
-- screen already applied and can change or waive each one. Applied charges reduce what the ticket
-- pays out (tickets.deductions) — never the material value, so inventory and purchase reports stay
-- at the full price. Applied once, in order, inside a transaction. Never edit after it has run.

CREATE TABLE IF NOT EXISTS box_charges (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind           TEXT NOT NULL,                       -- rent | mileage
  status         TEXT NOT NULL DEFAULT 'pending',     -- pending | applied | waived | void
  yard           TEXT,
  customer_name  TEXT NOT NULL,
  vendor_id      TEXT REFERENCES vendors(id),
  box_id         TEXT REFERENCES boxes(id),
  box_number     TEXT,
  job_id         TEXT REFERENCES box_jobs(id),
  move_id        TEXT REFERENCES box_moves(id),
  -- rent
  placed_at      TIMESTAMPTZ,
  picked_up_at   TIMESTAMPTZ,
  days_on_site   INTEGER,
  free_days      INTEGER,
  weekly_rate    NUMERIC(10,2),
  -- mileage
  truck          TEXT,
  trip_start     TIMESTAMPTZ,                         -- driver started the job
  trip_end       TIMESTAMPTZ,                         -- truck back across the scale (set when applied)
  miles          NUMERIC(10,1),
  miles_source   TEXT,                                -- motive | manual
  rate_per_mile  NUMERIC(10,2),
  odometer       JSONB,                               -- the Motive readings used, for the record
  -- money
  calc_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,    -- what the rule says
  amount         NUMERIC(10,2) NOT NULL DEFAULT 0,    -- what was charged (scale operator can change it)
  business       BOOLEAN NOT NULL DEFAULT false,      -- customer was a business when figured (rent waived automatically)
  ticket_id      TEXT REFERENCES tickets(id),
  applied_at     TIMESTAMPTZ,
  applied_by     TEXT REFERENCES users(id),
  waived_at      TIMESTAMPTZ,
  waived_by      TEXT REFERENCES users(id),
  waive_reason   TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_box_charges_open ON box_charges(status, lower(customer_name));
CREATE INDEX IF NOT EXISTS idx_box_charges_vendor ON box_charges(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_box_charges_ticket ON box_charges(ticket_id);
-- One rent charge per box leaving a customer, one mileage charge per job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_box_charges_rent_move ON box_charges(move_id, box_id) WHERE kind = 'rent';
CREATE UNIQUE INDEX IF NOT EXISTS uq_box_charges_mileage_job ON box_charges(job_id) WHERE kind = 'mileage';

-- What the ticket pays out = total - deductions. total stays the material value.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deductions NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Business customers aren't charged box rent. NULL = not set yet (Yard-Built guesses from the name).
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS box_rent_business BOOLEAN;

-- The truck on a job (driver's Truck # when they start it) — mileage comes from that truck.
ALTER TABLE box_jobs ADD COLUMN IF NOT EXISTS truck TEXT;

INSERT INTO app_settings (key, value) VALUES
  ('boxRentWeekly', '125'),
  ('boxRentFreeDays', '7'),
  ('boxMileageRate', 'null'),       -- $ per mile; null = mileage charges off until it's set
  ('boxMileageFreeMiles', '0'),
  ('boxMileageMinimum', '0')
ON CONFLICT (key) DO NOTHING;
