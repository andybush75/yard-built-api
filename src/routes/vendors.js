const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

// id_number_enc / dob_enc never leave the server through the list; the identity routes handle them.
const VENDOR_COLS = "id, name, phone, email, tier, notes, smartphone, on_price_list, auto_send, last_sent, created_at, active, address, id_type, id_last4, id_state, id_expires, plate, plate_state, id_updated_at";
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT ${VENDOR_COLS} FROM vendors ORDER BY name`);
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT ${VENDOR_COLS} FROM vendors WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.post("/", requireAuth, async (req, res) => {
  const { name, phone, email, tier, notes, smartphone, onPriceList, autoSend } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const { rows } = await query(
    `INSERT INTO vendors (name, phone, email, tier, notes, smartphone, on_price_list, auto_send)
     VALUES ($1,$2,$3,COALESCE($4::price_tier,'scale'),$5,COALESCE($6,false),COALESCE($7,false),COALESCE($8,'off'))
     RETURNING ${VENDOR_COLS}`,
    [name, phone, email, tier, notes, smartphone, onPriceList, autoSend]
  );
  res.status(201).json(rows[0]);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { name, phone, email, tier, notes, smartphone, onPriceList, autoSend, active, address } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: "name can't be blank" });
  const { rows } = await query(
    `UPDATE vendors SET
       name = COALESCE($2, name), phone = COALESCE($3, phone), email = COALESCE($4, email),
       tier = COALESCE($5, tier), notes = COALESCE($6, notes), smartphone = COALESCE($7, smartphone),
       on_price_list = COALESCE($8, on_price_list), auto_send = COALESCE($9, auto_send),
       active = COALESCE($10, active), address = COALESCE($11, address)
     WHERE id = $1 RETURNING ${VENDOR_COLS}`,
    [req.params.id, name !== undefined ? String(name).trim() : null, phone ?? null, email ?? null, tier ?? null, notes ?? null,
     smartphone ?? null, onPriceList ?? null, autoSend ?? null, active === undefined ? null : !!active, address ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// Hard delete is only allowed when nothing points at the vendor; otherwise deactivate instead.
router.delete("/:id", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { rows: v } = await query("SELECT id FROM vendors WHERE id = $1", [req.params.id]);
  if (!v.length) return res.status(404).json({ error: "Not found" });
  const [{ rows: t }, { rows: p }] = await Promise.all([
    query("SELECT count(*)::int AS n FROM tickets WHERE vendor_id = $1", [req.params.id]),
    query("SELECT count(*)::int AS n FROM purchase_orders WHERE vendor_id = $1", [req.params.id]),
  ]);
  if (t[0].n || p[0].n) {
    return res.status(409).json({ error: `This dealer has ${t[0].n} ticket(s) and ${p[0].n} purchase order(s) on file — deactivate them instead so the history stays intact.`, tickets: t[0].n, purchaseOrders: p[0].n });
  }
  await query("DELETE FROM vendors WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

router.use("/:id/identity", require("./partyIdentity"));

module.exports = router;
