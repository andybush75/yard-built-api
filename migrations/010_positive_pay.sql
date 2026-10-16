-- Migration 010: Positive Pay — bank account details + transmission log for issued/voided checks.
-- Applied once by `npm run migrate`; do NOT edit after it has run anywhere. Write a new migration instead.

-- Full account and routing numbers are needed in the positive-pay file. The account number is
-- encrypted at rest with ID_ENCRYPTION_KEY (same scheme as seller IDs); routing numbers are public.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number_enc    TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS routing_number        TEXT;
-- How this bank wants its file laid out: { format: csv|fixed, delimiter, header, dateFormat,
-- amountFormat, issueCode, voidCode, includeVoids, payeeMaxLength, fields: [...] }.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_config   JSONB;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_enabled  BOOLEAN NOT NULL DEFAULT false;

-- One row per file built and handed to the bank.
CREATE TABLE IF NOT EXISTS positive_pay_batches (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account      TEXT NOT NULL REFERENCES bank_accounts(yard),
  filename     TEXT NOT NULL,
  format       TEXT NOT NULL,
  item_count   INTEGER NOT NULL,
  issue_count  INTEGER NOT NULL DEFAULT 0,
  void_count   INTEGER NOT NULL DEFAULT 0,
  total        NUMERIC(14,2) NOT NULL DEFAULT 0,  -- sum of issued amounts in this file
  content      TEXT NOT NULL,                     -- the exact file sent, for re-download / audit
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT REFERENCES users(id)
);

-- Which checks have been reported, and as what. A check is reported as an 'issue' once and, if it
-- is later voided, as a 'void' once — never twice, which is what the unique index enforces.
CREATE TABLE IF NOT EXISTS positive_pay_items (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES positive_pay_batches(id) ON DELETE CASCADE,
  remittance_id TEXT NOT NULL REFERENCES remittances(id),
  kind          TEXT NOT NULL CHECK (kind IN ('issue','void')),
  check_number  TEXT NOT NULL,
  amount        NUMERIC(14,2) NOT NULL,
  payee         TEXT NOT NULL,
  issue_date    DATE NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_positive_pay_item ON positive_pay_items(remittance_id, kind);
CREATE INDEX IF NOT EXISTS idx_positive_pay_batches_account ON positive_pay_batches(account, created_at DESC);
