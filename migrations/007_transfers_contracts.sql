-- Migration 007: yard transfers (two linked tickets, margin to the sending yard) + contract/PO polish
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

CREATE SEQUENCE IF NOT EXISTS yard_transfer_seq START WITH 1;

CREATE TABLE IF NOT EXISTS yard_transfers (
  id             TEXT PRIMARY KEY,                 -- YT-<n>
  date           DATE NOT NULL,
  from_yard      TEXT NOT NULL,
  to_yard        TEXT NOT NULL,
  commodity      TEXT NOT NULL REFERENCES commodities(code),
  net_weight     NUMERIC(14,3) NOT NULL,
  margin_basis   TEXT NOT NULL DEFAULT 'pct',      -- pct (over master price) | perlb | perton
  margin_value   NUMERIC(10,4) NOT NULL DEFAULT 0,
  price          NUMERIC(10,4) NOT NULL,           -- transfer price, $/lb
  total          NUMERIC(14,2) NOT NULL,
  cogs_per_lb    NUMERIC(10,4),                    -- sending yard's average cost at the time
  margin_dollars NUMERIC(14,2),                    -- (price - cogs) × weight: what the sending yard books
  notes          TEXT,
  sell_ticket_id TEXT NOT NULL REFERENCES tickets(id),
  buy_ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  status         TEXT NOT NULL DEFAULT 'Open',     -- Open | Reconciled | Voided
  reconciled_at  TIMESTAMPTZ,
  reconciled_by  TEXT REFERENCES users(id),
  voided_at      TIMESTAMPTZ,
  voided_by      TEXT REFERENCES users(id),
  void_reason    TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yard_transfers_yards ON yard_transfers(from_yard, to_yard, date);

-- Each leg of a transfer knows its transfer and its twin.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transfer_id      TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS linked_ticket_id TEXT;

-- Company defaults the transfer form prefills, and the per-yard master-price multipliers the
-- prototype carried in code (SB is the reference; the others sit a few points under it).
INSERT INTO app_settings (key, value) VALUES
  ('transfer_default_margin_pct', '6'),
  ('yard_price_multipliers', '{"SB": 1.0, "HAYS": 0.97, "COLBY": 0.985, "RC": 0.955}')
ON CONFLICT (key) DO NOTHING;
