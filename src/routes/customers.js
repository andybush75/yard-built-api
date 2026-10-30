const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM customers ORDER BY name");
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM customers WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.post("/", requireAuth, async (req, res) => {
  const { name, phone, email, tier, freightPerLb, notes, onPriceList, autoSend, terms, address, businessExempt } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const { rows } = await query(
    `INSERT INTO customers (name, phone, email, tier, freight_per_lb, notes, on_price_list, auto_send, terms, address, business_exempt)
     VALUES ($1,$2,$3,COALESCE($4::price_tier,'scale'),COALESCE($5,0),$6,COALESCE($7,false),COALESCE($8,'off'),COALESCE($9,'cod'),$10,COALESCE($11,false))
     RETURNING *`,
    [name, phone, email, tier, freightPerLb, notes, onPriceList, autoSend, terms, address, businessExempt]
  );
  res.status(201).json(rows[0]);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { name, phone, email, tier, freightPerLb, notes, onPriceList, autoSend, terms, address, businessExempt, active } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: "name can't be blank" });
  const { rows } = await query(
    `UPDATE customers SET
       name = COALESCE($2, name), phone = COALESCE($3, phone), email = COALESCE($4, email),
       tier = COALESCE($5, tier), freight_per_lb = COALESCE($6, freight_per_lb), notes = COALESCE($7, notes),
       on_price_list = COALESCE($8, on_price_list), auto_send = COALESCE($9, auto_send),
       terms = COALESCE($10, terms), address = COALESCE($11, address), business_exempt = COALESCE($12, business_exempt),
       active = COALESCE($13, active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name !== undefined ? String(name).trim() : null, phone ?? null, email ?? null, tier ?? null, freightPerLb ?? null, notes ?? null,
     onPriceList ?? null, autoSend ?? null, terms ?? null, address ?? null, businessExempt ?? null, active === undefined ? null : !!active]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// Hard delete is only allowed when nothing points at the customer; otherwise deactivate instead.
router.delete("/:id", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { rows: c } = await query("SELECT id FROM customers WHERE id = $1", [req.params.id]);
  if (!c.length) return res.status(404).json({ error: "Not found" });
  const [{ rows: t }, { rows: k }, { rows: sh }] = await Promise.all([
    query("SELECT count(*)::int AS n FROM tickets WHERE customer_id = $1", [req.params.id]),
    query("SELECT count(*)::int AS n FROM contracts WHERE customer_id = $1", [req.params.id]),
    query("SELECT count(*)::int AS n FROM shipments WHERE customer_id = $1", [req.params.id]),
  ]);
  if (t[0].n || k[0].n || sh[0].n) {
    return res.status(409).json({ error: `This customer has ${t[0].n} ticket(s), ${k[0].n} contract(s) and ${sh[0].n} shipment(s) on file — deactivate them instead so the history stays intact.` });
  }
  await query("DELETE FROM customers WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
