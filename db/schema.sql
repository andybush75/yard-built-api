-- Yard-Built — Phase 0 "Real backend + database"
-- Core transactional schema mirrored from langer_yard_prototype.html's in-memory state.
-- Not yet covered here (left for follow-on roadmap items — same pattern extends to each):
-- maintenance/assets/work orders/inspections, dispatch/containers/box rent, KBI/LeadsOnline
-- reporting, QuickBooks sync, mill reconciliation, yard transfers, price lists/Twilio sends.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

DO $$ BEGIN
  CREATE TYPE commodity_unit AS ENUM ('net_ton', 'lb', 'each');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE price_tier AS ENUM ('scale', 'd2', 'd1', 'dh');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_terms AS ENUM ('cod', 'net15', 'net30', 'net60');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_type AS ENUM ('buy', 'sell');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE carrier_type AS ENUM ('owned', 'common', 'dedicated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS yards (
  code    TEXT PRIMARY KEY,         -- SB | HAYS | COLBY | RC (CORP is a virtual rollup, not a row)
  name    TEXT NOT NULL,
  address TEXT,
  zip     TEXT,
  state   TEXT                      -- NE | KS | SD — drives which compliance rules apply (e.g. KBI)
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT UNIQUE NOT NULL,
  system      BOOLEAN NOT NULL DEFAULT false,
  permissions TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT,              -- null until real login is wired up (Phase 0 item 2)
  role_id       TEXT NOT NULL REFERENCES roles(id),
  grants        TEXT[] NOT NULL DEFAULT '{}',
  revokes       TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commodities (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  ferrous       BOOLEAN NOT NULL DEFAULT false,
  unit          commodity_unit NOT NULL DEFAULT 'lb',
  low_threshold NUMERIC(14,3) NOT NULL DEFAULT 0,
  master_price  NUMERIC(10,4) NOT NULL DEFAULT 0,
  kiosk_show    BOOLEAN NOT NULL DEFAULT true,
  kiosk_color   TEXT,
  ask_price     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendors (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  tier          price_tier NOT NULL DEFAULT 'scale',
  notes         TEXT,
  smartphone    BOOLEAN NOT NULL DEFAULT false,
  on_price_list BOOLEAN NOT NULL DEFAULT false,
  auto_send     TEXT NOT NULL DEFAULT 'off',   -- off | update | daily
  last_sent     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  tier            price_tier NOT NULL DEFAULT 'scale',
  freight_per_lb  NUMERIC(10,4) NOT NULL DEFAULT 0,
  notes           TEXT,
  on_price_list   BOOLEAN NOT NULL DEFAULT false,
  auto_send       TEXT NOT NULL DEFAULT 'off',
  last_sent       TIMESTAMPTZ,
  terms           payment_terms NOT NULL DEFAULT 'cod',
  address         TEXT,
  business_exempt BOOLEAN NOT NULL DEFAULT false, -- never charged box rent; also the Commercial-vs-Public seam (roadmap item)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carriers (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name               TEXT NOT NULL,
  phone              TEXT,
  mc                 TEXT,
  notes              TEXT,
  type               carrier_type NOT NULL DEFAULT 'common',
  is_container_truck BOOLEAN NOT NULL DEFAULT false,
  asset_id           TEXT,          -- links to a Maintenance asset, once that module exists here
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
  id            TEXT PRIMARY KEY,   -- human-editable CT-#### / custom number is the real key
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  commodity     TEXT NOT NULL REFERENCES commodities(code),
  yard          TEXT NOT NULL,      -- one of the 4 yard codes, or "CORP"
  committed_qty NUMERIC(14,3) NOT NULL,
  shipped_qty   NUMERIC(14,3) NOT NULL DEFAULT 0,
  end_date      DATE NOT NULL,
  terms         payment_terms,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  commodity     TEXT NOT NULL REFERENCES commodities(code),
  yard          TEXT NOT NULL,
  committed_qty NUMERIC(14,3) NOT NULL,
  received_qty  NUMERIC(14,3) NOT NULL DEFAULT 0,
  end_date      DATE NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipments (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  yard        TEXT NOT NULL,
  date        DATE NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  party_name  TEXT,
  bol_number  TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  yard             TEXT PRIMARY KEY REFERENCES yards(code),
  bank_name        TEXT NOT NULL,
  last4            TEXT NOT NULL,
  starting_balance NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remittances (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  payee         TEXT NOT NULL,
  method        TEXT NOT NULL,
  check_number  TEXT,
  account       TEXT NOT NULL,      -- yard whose bank account this is drawn from
  date          DATE NOT NULL,
  total         NUMERIC(14,2) NOT NULL,
  emailed       BOOLEAN NOT NULL DEFAULT false,
  printed       BOOLEAN NOT NULL DEFAULT false,
  check_printed BOOLEAN NOT NULL DEFAULT false,
  voided        BOOLEAN NOT NULL DEFAULT false,
  cleared       BOOLEAN NOT NULL DEFAULT false,
  cleared_date  DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS remittance_lines (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  remittance_id TEXT NOT NULL REFERENCES remittances(id),
  kind          TEXT NOT NULL,      -- ticket | freight
  ref_id        TEXT NOT NULL,
  amount        NUMERIC(14,2) NOT NULL
);

-- Continues the prototype's seeded numbering (last seeded: B-4002 / S-3001) so generated ids don't collide with demo data.
CREATE SEQUENCE IF NOT EXISTS ticket_buy_seq START WITH 4003;
CREATE SEQUENCE IF NOT EXISTS ticket_sell_seq START WITH 3002;

CREATE TABLE IF NOT EXISTS tickets (
  id             TEXT PRIMARY KEY,  -- B-1042 / S-2091 style human-readable id
  type           ticket_type NOT NULL,
  date           DATE NOT NULL,
  yard           TEXT NOT NULL,
  vendor_id      TEXT REFERENCES vendors(id),
  customer_id    TEXT REFERENCES customers(id),
  party_name     TEXT NOT NULL,     -- snapshot of the vendor/customer name, or a Walk-in hold description
  hold_desc      TEXT,
  commodity      TEXT NOT NULL REFERENCES commodities(code),
  tier           price_tier,
  net_weight     NUMERIC(14,3) NOT NULL,
  price          NUMERIC(10,4) NOT NULL,
  total          NUMERIC(14,2) NOT NULL,
  payment        TEXT NOT NULL,     -- Check | ACH | Internal Transfer
  synced         BOOLEAN NOT NULL DEFAULT false,
  paid           BOOLEAN NOT NULL DEFAULT false,
  status         TEXT,              -- Closed | Held | Pending Weight | ...
  cogs_per_lb    NUMERIC(10,4),
  kind           TEXT,              -- "transfer" tags a yard-transfer leg so reports can exclude it
  contract_id    TEXT REFERENCES contracts(id),
  po_id          TEXT REFERENCES purchase_orders(id),
  shipment_id    TEXT REFERENCES shipments(id),
  remittance_id  TEXT REFERENCES remittances(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_yard_date ON tickets(yard, date);
CREATE INDEX IF NOT EXISTS idx_tickets_commodity ON tickets(commodity);

CREATE TABLE IF NOT EXISTS freight_tickets (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ticket_id          TEXT NOT NULL REFERENCES tickets(id),
  carrier_id         TEXT NOT NULL REFERENCES carriers(id),
  lane_id            TEXT,
  origin             TEXT NOT NULL,
  destination        TEXT NOT NULL,
  cost               NUMERIC(10,2) NOT NULL,
  status             TEXT NOT NULL,    -- Estimated | Reconciled
  date               DATE NOT NULL,
  notes              TEXT,
  paid               BOOLEAN NOT NULL DEFAULT false,
  capitalized_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  capitalized_note   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_balances (
  yard       TEXT NOT NULL,
  commodity  TEXT NOT NULL REFERENCES commodities(code),
  qty        NUMERIC(14,3) NOT NULL DEFAULT 0,
  avg_cost   NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (yard, commodity)
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  yard        TEXT NOT NULL,
  commodity   TEXT NOT NULL REFERENCES commodities(code),
  type        TEXT NOT NULL,  -- Opening | Buy | Sell | Transfer In/Out | Pack | Unpack | Adjustment | Correction | Regrade in/out | Import | Freight-in
  qty_change  NUMERIC(14,3) NOT NULL,
  unit_price  NUMERIC(10,4),
  balance_qty NUMERIC(14,3) NOT NULL,
  avg_cost    NUMERIC(10,4) NOT NULL,
  cash_cost   NUMERIC(14,2) NOT NULL,
  ref         TEXT,
  date        DATE NOT NULL,
  time        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_yard_commodity_date ON inventory_ledger(yard, commodity, date);

-- A starting point for Phase 0's "Audit trail" item (not yet wired into every route — tracked
-- separately on the roadmap). Generic enough that any route can insert into it as that work lands.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT REFERENCES users(id),
  action     TEXT NOT NULL,     -- e.g. "ticket.create", "commodity.update"
  entity     TEXT NOT NULL,     -- table/entity name
  entity_id  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permission backfill for roles that already exist in production. seed.js does not run on deploy,
-- so when a route starts requiring a new permission key, the built-in roles that should have it
-- are granted it here. Each statement is a no-op once the key is present, so re-running is safe.
UPDATE roles SET permissions = permissions || '{payRemittances}'
  WHERE name IN ('Admin', 'Yard Manager', 'Cashier') AND NOT (permissions @> '{payRemittances}');
UPDATE roles SET permissions = permissions || '{editBankAccounts}'
  WHERE name = 'Admin' AND NOT (permissions @> '{editBankAccounts}');
