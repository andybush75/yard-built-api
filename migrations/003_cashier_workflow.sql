-- Migration 003: Hold → Cashier → Pay workflow, ticket void, check numbering, timeline
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Who did what, when. Ticket status is one of Held | Closed | Voided; `paid` says whether a
-- Closed buy ticket has been paid (its remittance_id says on which check).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_by  TEXT REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at   TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by   TEXT REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS voided_by   TEXT REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Sell tickets were posted with no status; every ticket now carries one.
UPDATE tickets SET status = 'Closed' WHERE status IS NULL;
ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'Closed';
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, paid);

ALTER TABLE remittances ADD COLUMN IF NOT EXISTS created_by  TEXT REFERENCES users(id);
ALTER TABLE remittances ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE remittances ADD COLUMN IF NOT EXISTS voided_by   TEXT REFERENCES users(id);
ALTER TABLE remittances ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Each yard's account hands out check numbers in order. An admin sets this once to match the
-- check stock (PATCH /bank-accounts/:yard { nextCheckNumber }); a typed number can override.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS next_check_number INTEGER NOT NULL DEFAULT 1001;

-- The ticket timeline reads the audit log by entity.
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, created_at);
