const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { yard } = req.query;
  const { rows } = yard
    ? await query("SELECT * FROM purchase_orders WHERE yard = $1 ORDER BY end_date", [yard])
    : await query("SELECT * FROM purchase_orders ORDER BY end_date");
  res.json(rows);
});

router.post("/", requireAuth, async (req, res) => {
  const { id, vendorId, commodity, yard, committedQty, endDate, notes } = req.body || {};
  if (!id || !vendorId || !commodity || !yard || !committedQty || !endDate) {
    return res.status(400).json({ error: "id, vendorId, commodity, yard, committedQty, and endDate are required" });
  }
  try {
    const { rows } = await query(
      `INSERT INTO purchase_orders (id, vendor_id, commodity, yard, committed_qty, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, vendorId, commodity, yard, committedQty, endDate, notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Purchase order ${id} already exists` });
    throw err;
  }
});

module.exports = router;
