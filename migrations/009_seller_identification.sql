-- Migration 009: seller identification (driver's license / ID + thumbprint) on vendors
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- The ID number itself is stored encrypted (AES-256-GCM, key in ID_ENCRYPTION_KEY) — only the
-- last four digits are kept in the clear for display. Images live in party_images for now
-- (small JPEGs, capped by the API); they move to object storage when volume justifies it.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_type        TEXT;          -- dl | state_id | passport | other
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_number_enc  TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_last4       TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_state       TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_expires     DATE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS dob_enc        TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS plate          TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS plate_state    TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_updated_at  TIMESTAMPTZ;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS id_updated_by  TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS party_images (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor_id  TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- id_front | thumbprint
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  size       INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT REFERENCES users(id),
  UNIQUE (vendor_id, kind)
);

-- Every reveal of a full ID number, every image view, and every change is logged with who/when.
CREATE TABLE IF NOT EXISTS id_access_log (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor_id  TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id),
  action     TEXT NOT NULL,            -- reveal | view_id_front | view_thumbprint | update | upload_* | delete
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_id_access_vendor ON id_access_log(vendor_id, at DESC);

-- What ID was on file when a ticket was written (masked: type, last4, state, plate). KBI / police
-- requests are answered per transaction, not just per person.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS id_snapshot JSONB;

-- Seeing full numbers and images is its own permission; Admin gets it out of the box.
UPDATE roles SET permissions = array_append(permissions, 'viewIds') WHERE name = 'Admin' AND NOT ('viewIds' = ANY(permissions));
