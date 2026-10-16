const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { yard } = req.query;
  const { rows } = yard
    ? await query("SELECT * FROM contracts WHERE yard = $1 ORDER BY end_date", [yard])
    : await query("SELECT * FROM contracts ORDER BY end_date");
  res.json(rows);
});

router.post("/", requireAuth, async (req, res) => {
  const { id, customerId, commodity, yard, committedQty, endDate, terms, notes, shippedQty } = req.body || {};
  if (!id || !customerId || !commodity || !yard || !committedQty || !endDate) {
    return res.status(400).json({ error: "id, customerId, commodity, yard, committedQty, and endDate are required" });
  }
  try {
    const { rows } = await query(
      `INSERT INTO contracts (id, customer_id, commodity, yard, committed_qty, end_date, terms, notes, shipped_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0)) RETURNING *`,
      [id, customerId, commodity, yard, committedQty, endDate, terms || null, notes || null, shippedQty]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Contract ${id} already exists` });
    throw err;
  }
});

// Renaming a contract number carries forward automatically since every linked ticket references
// this same primary key — no separate "update tickets" step needed.
router.patch("/:id/rename", requireAuth, async (req, res) => {
  const { newId } = req.body || {};
  if (!newId) return res.status(400).json({ error: "newId is required" });
  try {
    const { rows } = await query("UPDATE contracts SET id = $2 WHERE id = $1 RETURNING *", [req.params.id, newId]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Contract ${newId} already in use` });
    throw err;
  }
});

// Edit the terms of a contract (not its shipped total — that comes from tickets).
router.patch("/:id", requireAuth, async (req, res) => {
  const { committedQty, endDate, terms, notes } = req.body || {};
  const { rows } = await query(
    `UPDATE contracts SET committed_qty = COALESCE($2, committed_qty), end_date = COALESCE($3, end_date),
                          terms = COALESCE($4, terms), notes = COALESCE($5, notes)
     WHERE id = $1 RETURNING *`,
    [req.params.id, committedQty ?? null, endDate ?? null, terms ?? null, notes ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
