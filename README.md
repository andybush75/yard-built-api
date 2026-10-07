# Yard-Built API

The real backend + database for Yard-Built (ERP roadmap Phase 0, item 1). Node.js + Express +
Postgres, built to deploy on Railway the same way **Langer Boxes** already does.

This is the foundation layer only: auth, roles/permissions, and the core transactional entities
(commodities, vendors, customers, carriers, contracts, purchase orders, tickets, inventory
balances + ledger, bank accounts, remittances, shipments, freight tickets). It does not yet cover
maintenance/assets/work orders, dispatch/containers/box rent, KBI/LeadsOnline reporting,
QuickBooks sync, mill reconciliation, yard transfers, or price-list sends — those are later
roadmap items and extend the exact same pattern (a table + a router file) one module at a time.

## What's actually proven here

The part of "real backend + database" that matters most is **inventory posting under
concurrency** — two people working the same yard at once without silently overwriting each
other's numbers, which an in-memory browser prototype structurally cannot do. `POST /tickets`
wraps the whole operation (lock the inventory row, recompute moving-average cost, write the
ticket, write the ledger entry) in a single database transaction with `SELECT ... FOR UPDATE`.
This was load-tested in this session: 20 simultaneous buy tickets against the same yard/commodity
all landed with zero lost updates.

## Local development

```bash
npm install
cp .env.example .env   # then edit DATABASE_URL to point at your local Postgres
npm run migrate        # applies any migrations/*.sql not yet applied to this database (safe to re-run)
npm run seed           # demo data: 4 yards, roles/users, commodities, vendors (incl. the
                        # Dale Hendricks/Dale Hendrix duplicate-vendor pair), customers, a
                        # contract, a PO, and a few posted demo tickets
npm run dev            # starts the API on :4000
npm test               # end-to-end smoke test against the running server
```

Default seeded login: `andy.bush@langerindustrial.com` / `changeme123` — **change this password
before any real deploy**; it's a seed placeholder, not a real credential.

## Deploying to Railway

This hasn't been deployed yet — that needs your own Railway account, so here's exactly what to
do, matching how Langer Boxes is already set up:

1. In the Railway dashboard, create a new project (or add a service to an existing one if you
   want this alongside Langer Boxes).
2. **Add a Postgres plugin** to the project (Railway → New → Database → PostgreSQL). Railway
   provisions it and exposes a `DATABASE_URL` variable automatically.
3. **Add this repo as a service** (New → GitHub Repo, or `railway up` from this folder via the
   Railway CLI if you'd rather not push to GitHub first).
4. **Link the two**: in the API service's Variables tab, reference the Postgres plugin's
   `DATABASE_URL` (Railway's "Add variable reference" picker does this for you — same pattern
   Langer Boxes uses).
5. Set the other variables: `JWT_SECRET` (generate a long random value — don't reuse the dev one
   in this repo) and `PORT` (Railway sets this itself; the app already reads `process.env.PORT`).
6. Set the service's start command to `npm run migrate && npm start` (or run `npm run migrate`
   once manually via the Railway CLI the first time, then just `npm start` after) so the schema
   gets applied on first deploy and on any future schema change.
7. Decide whether to run `npm run seed` against the production database — probably **not** with
   this file's demo data (Dale Hendrix et al. are fictional), but the same `db/seed.js` pattern
   is the right place to load your real opening vendor/customer/commodity lists once you're ready
   to migrate real data in (that's the Phase 5 "Migration tooling" roadmap item).

## API shape

All routes except `/health` and `/auth/login` require `Authorization: Bearer <token>` from
`POST /auth/login`. Routes marked with a permission key return 403 unless the user's role (or an
individual grant) includes it; everything else is open to any logged-in user.

- `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password` (own password; needs the current one)
- `GET /users` (any user — the directory), `POST/PATCH /users` — writes need `manageUsers`. Users are
  deactivated (`active: false`), never deleted. You can't change your own access, and no change may
  leave zero active users with `manageUsers`.
- `GET /roles`, `POST/PATCH/DELETE /roles` — writes need `manageUsers`; built-in roles can't be
  edited or deleted; a role with users on it can't be deleted.
- `GET/POST/PATCH /commodities` — POST needs `addCommodity`, PATCH needs `editPricing`
- `GET/POST/PATCH /vendors`, `/customers`
- `GET/POST /carriers`
- `GET/POST /contracts` (+ `PATCH /contracts/:id/rename`), `/purchase-orders`
- `GET/PATCH /bank-accounts` — PATCH (`startingBalance`, `nextCheckNumber`) needs `editBankAccounts`
- `GET/POST /tickets` — the core transactional endpoint described above. Buy tickets post as
  `Held`; sell tickets as `Closed`. `GET /tickets` filters: `yard, type, commodity, status, paid,
  vendorId, customerId, q`. `GET /tickets/:id` returns the ticket plus its remittance and a
  `timeline` (audit entries with the user's name).
- `POST /tickets/:id/pay-later` (`payRemittances`) — Held → Closed, unpaid, to AP. Refused for walk-ins.
- `POST /tickets/:id/pay` (`payRemittances`) — cuts a one-line Check/ACH for this ticket now.
  Body: `method, checkNumber?, account?, payee?` (payee required for a walk-in). Check numbers are
  auto-assigned from the account's `next_check_number` unless typed; a typed number already used
  on that account is refused.
- `POST /tickets/:id/void` (`voidTickets`) — body `reason`; reverses inventory; a paid ticket must
  have its remittance voided first.
- `GET /inventory/balances`, `/inventory/ledger`, `/inventory/negative`
- `GET/POST /remittances`, `GET /remittances/:id`, `PATCH /remittances/:id` (printed / checkPrinted /
  emailed / cleared flags), `POST /remittances/:id/void` (body `reason`) — writes need `payRemittances`
- `GET /search?q=` — tickets (id, party, hold description, amount), dealers and customers (name,
  phone), and checks (number, payee) in one answer

Every action on a ticket writes an `audit_log` row (`src/audit.js`); the ticket timeline is those rows.

New permission keys must be added in three places: the role seeds in `db/seed.js`, a new
migration that grants them to the existing production roles (see `001_initial_schema.sql`'s last
block for the pattern), and the `PERMISSIONS` list in `src/public/index.html` so the role editor
can show them.

## Changing the database

The schema lives in `migrations/`, one numbered SQL file per change. `npm run migrate` applies
whichever files a database hasn't seen yet, in order, and records each in a `schema_migrations`
table. It runs automatically on every Railway deploy before the app starts.

To change the database:

1. `npm run migrate:new add_ticket_status` → creates `migrations/002_add_ticket_status.sql`.
2. Write the SQL in that file (`ALTER TABLE tickets ADD COLUMN ...`).
3. Commit it with the code that uses it. On deploy it is applied once, and the deploy fails loudly
   if it errors — the app never starts against a half-changed database.

Never edit a migration file that has already been applied anywhere (production especially). The
runner stores a checksum and refuses to start if one changes. Write a new file instead.

`001_initial_schema.sql` is the former `db/schema.sql`, frozen. It is written with
`IF NOT EXISTS` everywhere, so applying it to the existing production database (whose tables were
created by the old runner) changes nothing except recording it as applied.

## Next steps on the roadmap this unblocks

Real login/role enforcement (Phase 0 item 2) now has somewhere to attach — `password_hash` is
already a column, JWT issuance already works, `requirePermission()` already mirrors the
prototype's permission model. Audit trail (Phase 0 item 4) has a starter `audit_log` table
sitting unused — wiring inserts into it from each route is the remaining work. Everything else
in Phase 0 (backups, hosting/deployment pipeline) is a Railway-configuration task once this is
actually deployed there.
