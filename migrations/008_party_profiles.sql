-- Migration 008: vendor / customer profiles can be deactivated; vendors get an address
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- A party with ticket history is never deleted (tickets, remittances and contracts point at it);
-- it is deactivated, which hides it from pickers and lists. Parties with no history may be deleted.
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS active  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS address TEXT;
