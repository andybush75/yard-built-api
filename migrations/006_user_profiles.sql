-- Migration 006: user profiles for the teammate trial
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Who each person is, beyond a name and a role:
--   title / phone        shown on the user directory and the top-bar chip
--   home_yard            the yard the app opens on after sign-in (NULL = Scottsbluff/default)
--   yards                which yards they may switch to; empty array = every yard + Corporate
--   must_change_password set on new accounts and admin password resets; the UI forces a change
--                        before anything else loads, and change-password clears it
--   last_login_at        so an admin can see who has actually tried the trial
ALTER TABLE users ADD COLUMN IF NOT EXISTS title                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_yard            TEXT REFERENCES yards(code);
ALTER TABLE users ADD COLUMN IF NOT EXISTS yards                TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at        TIMESTAMPTZ;
