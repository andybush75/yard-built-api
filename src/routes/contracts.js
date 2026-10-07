const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const YARDS = ["SB", "HAYS", "COLBY", "RC", "CORP"];
const TERMS = ["cod", "net15", "net30", "net60"];
const SELECT = "SELECT c.*, cu.name AS customer_name FROM contracts c JOIN customers cu ON cu.id = c.customer_id";

router.get("/", requireAuth, async (req, res) => {
  const { yard } = req.query;
  const { rows } = yard
    ? await query(`${SELECT} WHERE c.yard = $1 ORDER BY c.end_date`, [yard])
    : await query(`${SELECT} ORDER BY c.end_date`);
  res.json(rows);
});

// A customer's commitment to take a quantity of a commodity by a date. The id is the contract /
// PO number people use (CT-1004 by default, or the customer's own number).
router.post("/", requireAuth, async (req, res) => {
  const { id, customerId, commodity, yard, committedQty, shippedQty, endDate, terms, notes } = req.body || {};
  if (!id || !id.trim() || !customerId || !commodity || !yard || !endDate) {
    return res.status(400).json({ error: "id, customerId, commodity, yard, and endDate are required" });
  }
  if (!(parseFloat(committedQty) > 0)) return res.status(400).json({ error: "committedQty must be greater than zero" });
  if (!YARDS.includes(yard)) return res.status(400).json({ error: `yard must be one of ${YARDS.join(", ")}` });
  if (terms && !TERMS.includes(terms)) return res.status(400).json({ error: `terms must be one of ${TERMS.join(", ")}` });
  const { rows: cu } = await query("SELECT id FROM customers WHERE id = $1", [customerId]);
  if (!cu.length) return res.status(400).json({ error: "customerId does not match any customer" });
  try {
    const { rows } = await query(
      `INSERT INTO contracts (id, customer_id, commodity, yard, committed_qty, shipped_qty, end_date, terms, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),$7,$8,$9) RETURNING id`,
      [id.trim(), customerId, commodity, yard, committedQty, shippedQty, endDate, terms || null, notes || null]
    );
    const { rows: out } = await query(`${SELECT} WHERE c.id = $1`, [rows[0].id]);
    res.status(201).json(out[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Contract ${id} already exists` });
    if (err.code === "23503") return res.status(400).json({ error: "commodity does not match any commodity" });
    throw err;
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { committedQty, endDate, terms, notes } = req.body || {};
  if (terms !== undefined && terms !== null && terms !== "" && !TERMS.includes(terms)) return res.status(400).json({ error: `terms must be one of ${TERMS.join(", ")}` });
  const { rows } = await query(
    `UPDATE contracts SET committed_qty = COALESCE($2, committed_qty), end_date = COALESCE($3, end_date),
       terms = CASE WHEN $4::text = '' THEN NULL ELSE COALESCE($4::payment_terms, terms) END, notes = COALESCE($5, notes)
     WHERE id = $1 RETURNING id`,
    [req.params.id, committedQty ?? null, endDate ?? null, terms === undefined ? null : (terms === null ? "" : terms), notes ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const { rows: out } = await query(`${SELECT} WHERE c.id = $1`, [req.params.id]);
  res.json(out[0]);
});

// Shipments entered as sell tickets linked to the contract post here automatically; this is for
// a shipment recorded outside that flow.
router.post("/:id/log-shipment", requireAuth, async (req, res) => {
  const qty = parseFloat((req.body || {}).qty);
  if (!(qty > 0)) return res.status(400).json({ error: "qty must be greater than zero" });
  const { rows } = await query("UPDATE contracts SET shipped_qty = shipped_qty + $2 WHERE id = $1 RETURNING id", [req.params.id, qty]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const { rows: out } = await query(`${SELECT} WHERE c.id = $1`, [req.params.id]);
  res.json(out[0]);
});

// Renaming a contract number carries forward to its tickets (the id is their foreign key).
router.patch("/:id/rename", requireAuth, async (req, res) => {
  const { newId } = req.body || {};
  if (!newId || !newId.trim()) return res.status(400).json({ error: "newId is required" });
  try {
    const { rows } = await query("UPDATE contracts SET id = $2 WHERE id = $1 RETURNING id", [req.params.id, newId.trim()]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const { rows: out } = await query(`${SELECT} WHERE c.id = $1`, [newId.trim()]);
    res.json(out[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Contract ${newId} already in use` });
    throw err;
  }
});

module.exports = router;
