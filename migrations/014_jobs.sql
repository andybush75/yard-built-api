-- Migration 014: background jobs.
--
-- pg-boss (the queue/scheduler library) keeps its own tables in a separate "pgboss" schema that it
-- creates and migrates itself; nothing here touches that. These tables are Yard-Built's own record
-- of what each job did, which is what the Settings → Jobs screen shows: one row per attempt, with
-- the result or the error, so a failed QuickBooks transfer or price-sheet send is visible and can
-- be retried — the same thing ScrapDragon's Hangfire dashboard gives its admins.

CREATE TABLE IF NOT EXISTS job_runs (
  id            BIGSERIAL PRIMARY KEY,
  job_name      TEXT NOT NULL,                 -- registry key, e.g. price-sheet-send
  queue_job_id  TEXT,                          -- pg-boss job id, for cross-reference
  status        TEXT NOT NULL DEFAULT 'queued',-- queued | running | succeeded | failed | skipped
  trigger       TEXT NOT NULL,                 -- schedule | manual | retry
  triggered_by  TEXT REFERENCES users(id),     -- who clicked Run now / Retry (null for the schedule)
  retry_of      BIGINT REFERENCES job_runs(id),-- the run this one re-ran, when trigger = retry
  payload       JSONB,                         -- what the job was asked to do
  result        JSONB,                         -- what it reports back on success / skip
  error         TEXT,                          -- message + stack on failure
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name_queued ON job_runs(job_name, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status) WHERE status IN ('queued', 'running', 'failed');

-- One row per text message the price-sheet job sends (or would have sent, in dry-run), replacing
-- the browser-side demo log the Vendor Price Sheets tab used to make up.
CREATE TABLE IF NOT EXISTS price_sheet_sends (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT REFERENCES job_runs(id) ON DELETE SET NULL,
  vendor_id     TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name   TEXT NOT NULL,
  phone         TEXT,
  yard          TEXT NOT NULL,
  tier          TEXT NOT NULL,
  channel       TEXT NOT NULL,                 -- SMS | MMS | none
  status        TEXT NOT NULL,                 -- sent | dry_run | failed | skipped
  detail        TEXT,                          -- Twilio error, "no phone on file", etc.
  twilio_sid    TEXT,
  body          TEXT,                          -- the message as sent
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_sheet_sends_yard ON price_sheet_sends(yard, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_sheet_sends_vendor ON price_sheet_sends(vendor_id, sent_at DESC);

-- Which yard's prices a dealer gets texted. Dealers imported from ScrapDragon carry their yards in
-- notes only; until this is set, the price-sheet job falls back to the priceSheet.defaultYard
-- setting (then SB).
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS home_yard TEXT REFERENCES yards(code);
