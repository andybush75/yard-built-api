-- Migration 011: a Positive Pay file may cover every yard's account at once (the way the
-- ScrapDragon check register did), so a batch's account can be NULL = "all accounts".
ALTER TABLE positive_pay_batches ALTER COLUMN account DROP NOT NULL;
