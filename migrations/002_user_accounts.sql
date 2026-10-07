-- Migration 002: user accounts can be deactivated
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Users are never deleted (tickets, remittances and the audit log will reference them); they are
-- deactivated instead, which blocks login and hides them from assignee lists.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
