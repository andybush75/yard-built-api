const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const YARDS = ["SB", "HAYS", "COLBY", "RC", "CORP"];
const SELECT = "SELECT p.*, v.name AS vendor_name FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id";

router.get("/", requireAuth, async (req, res) => {
  const { yard } = req.query;
  const { rows } = yard
    ? await query(`${SELECT} WHERE p.yard = $1 ORDER BY p.end_date`, [yard])
    : await query(`${SELECT} ORDER BY p.end_date`);
  res.json(rows);
});

// A vendor's commitment to bring in a quantity of a commodity by a date — the buy-side mirror of a
// contract. Buy tickets linked to the PO post their weight to received_qty automatically.
router.post("/", requireAuth, async (req, res) => {
  const { id, vendorId, commodity, yard, committedQty, receivedQty, endDate, notes } = req.body || {};
  if (!id || !id.trim() || !vendorId || !commodity || !yard || !endDate) {
    return res.status(400).json({ error: "id, vendorId, commodity, yard, and endDate are required" });
  }
  if (!(parseFloat(committedQty) > 0)) return res.status(400).json({ error: "committedQty must be greater than zero" });
  if (!YARDS.includes(yard)) return res.status(400).json({ error: `yard must be one of ${YARDS.join(", ")}` });
  const { rows: v } = await query("SELECT id FROM vendors WHERE id = $1", [vendorId]);
  if (!v.length) return res.status(400).json({ error: "vendorId does not match any vendor" });
  try {
    const { rows } = await query(
      `INSERT INTO purchase_orders (id, vendor_id, commodity, yard, committed_qty, received_qty, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),$7,$8) RETURNING id`,
      [id.trim(), vendorId, commodity, yard, committedQty, receivedQty, endDate, notes || null]
    );
    const { rows: out } = await query(`${SELECT} WHERE p.id = $1`, [rows[0].id]);
    res.status(201).json(out[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Purchase order ${id} already exists` });
    if (err.code === "23503") return res.status(400).json({ error: "commodity does not match any commodity" });
    throw err;
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { committedQty, endDate, notes } = req.body || {};
  const { rows } = await query(
    "UPDATE purchase_orders SET committed_qty = COALESCE($2, committed_qty), end_date = COALESCE($3, end_date), notes = COALESCE($4, notes) WHERE id = $1 RETURNING id",
    [req.params.id, committedQty ?? null, endDate ?? null, notes ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const { rows: out } = await query(`${SELECT} WHERE p.id = $1`, [req.params.id]);
  res.json(out[0]);
});

router.post("/:id/log-receipt", requireAuth, async (req, res) => {
  const qty = parseFloat((req.body || {}).qty);
  if (!(qty > 0)) return res.status(400).json({ error: "qty must be greater than zero" });
  const { rows } = await query("UPDATE purchase_orders SET received_qty = received_qty + $2 WHERE id = $1 RETURNING id", [req.params.id, qty]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const { rows: out } = await query(`${SELECT} WHERE p.id = $1`, [req.params.id]);
  res.json(out[0]);
});

router.patch("/:id/rename", requireAuth, async (req, res) => {
  const { newId } = req.body || {};
  if (!newId || !newId.trim()) return res.status(400).json({ error: "newId is required" });
  try {
    const { rows } = await query("UPDATE purchase_orders SET id = $2 WHERE id = $1 RETURNING id", [req.params.id, newId.trim()]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const { rows: out } = await query(`${SELECT} WHERE p.id = $1`, [newId.trim()]);
    res.json(out[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Purchase order ${newId} already in use` });
    throw err;
  }
});

module.exports = router;
