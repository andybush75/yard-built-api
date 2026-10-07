-- Migration 004: freight module — lanes, freight ticket lifecycle, carriers paid by remittance
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Optional route presets: origin → destination with a preferred carrier and a rate.
CREATE TABLE IF NOT EXISTS freight_lanes (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  origin      TEXT NOT NULL,
  destination TEXT NOT NULL,
  carrier_id  TEXT REFERENCES carriers(id),
  rate_basis  TEXT NOT NULL DEFAULT 'flat',   -- flat | per_mile | per_ton
  rate        NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A freight ticket can be written before the carrier is known ("none yet").
ALTER TABLE freight_tickets ALTER COLUMN carrier_id DROP NOT NULL;
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS remittance_id  TEXT REFERENCES remittances(id);
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS created_by     TEXT REFERENCES users(id);
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS reconciled_at  TIMESTAMPTZ;
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS reconciled_by  TEXT REFERENCES users(id);
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS voided_at      TIMESTAMPTZ;
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS voided_by      TEXT REFERENCES users(id);
ALTER TABLE freight_tickets ADD COLUMN IF NOT EXISTS void_reason    TEXT;

-- One freight ticket per scale ticket (business rule). Voided ones don't count, so a load can be
-- re-attached after a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS uq_freight_live_per_ticket ON freight_tickets(ticket_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_freight_carrier_status ON freight_tickets(carrier_id, status, paid);

-- Remittance lines already allow kind = 'freight'; this makes the reference discoverable.
CREATE INDEX IF NOT EXISTS idx_remittance_lines_ref ON remittance_lines(kind, ref_id);
