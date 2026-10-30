-- Migration 018: per-customer mileage rate. NULL = use the company rate (app_settings boxMileageRate);
-- 0 = never charge this customer mileage. Whatever rate applies is copied onto each mileage charge
-- when it's created, so changing a rate later doesn't rewrite charges already taken on tickets.
-- Applied once, in order, inside a transaction. Never edit after it has run anywhere.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS box_mileage_rate NUMERIC(10,2);
