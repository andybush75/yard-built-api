-- Migration 012: Documents — files attached to tickets, dealers, customers, contracts, POs,
-- trailers or the company itself. Stored in Postgres for now (same "step one" as seller IDs);
-- a move to object storage later only changes where `bytes` lives.

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL,            -- disclosure | id_scan | bol | weight_ticket | contract | price_agreement | insurance | vehicle | invoice | permit | photo | other
  entity_type  TEXT NOT NULL,            -- ticket | vendor | customer | contract | po | trailer | company
  entity_id    TEXT,                     -- NULL for company-level documents
  entity_label TEXT,                     -- what it was attached to, as shown at upload time (survives renames/deletes)
  yard         TEXT,                     -- yard it belongs to, if any
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  bytes        BYTEA NOT NULL,
  notes        TEXT,
  doc_date     DATE,                     -- the date ON the document (BOL date, policy start…); defaults to upload day
  expires_on   DATE,                     -- insurance, permits, price agreements
  uploaded_by  TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  deleted_by   TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_expires ON documents(expires_on) WHERE deleted_at IS NULL AND expires_on IS NOT NULL;

-- Who may delete documents or edit ones they didn't upload.
UPDATE roles SET permissions = array_append(permissions, 'manageDocuments')
WHERE name = 'Admin' AND NOT ('manageDocuments' = ANY(permissions));
