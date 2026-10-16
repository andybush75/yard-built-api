-- Migration 007: contract / PO numbers can be renamed
-- Applied once, in order, inside a transaction, by `npm run migrate` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

-- Contract and PO numbers are the primary key and the user is allowed to change them (their own
-- numbering vs. the auto CT-####). Tickets point at them, so the reference has to follow the rename.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_contract_id_fkey;
ALTER TABLE tickets ADD CONSTRAINT tickets_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON UPDATE CASCADE;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_po_id_fkey;
ALTER TABLE tickets ADD CONSTRAINT tickets_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON UPDATE CASCADE;
