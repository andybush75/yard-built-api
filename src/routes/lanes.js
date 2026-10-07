const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const BASES = ["flat", "per_mile", "per_ton"];

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT l.*, c.name AS carrier_name FROM freight_lanes l LEFT JOIN carriers c ON c.id = l.carrier_id ORDER BY l.origin, l.destination"
  );
  res.json(rows);
});

router.post("/", requireAuth, async (req, res) => {
  const { origin, destination, carrierId, rateBasis, rate, notes } = req.body || {};
  if (!origin || !destination) return res.status(400).json({ error: "origin and destination are required" });
  if (rateBasis !== undefined && !BASES.includes(rateBasis)) return res.status(400).json({ error: `rateBasis must be one of ${BASES.join(", ")}` });
  if (carrierId) {
    const { rows: c } = await query("SELECT id FROM carriers WHERE id = $1", [carrierId]);
    if (!c.length) return res.status(400).json({ error: "carrierId does not match any carrier" });
  }
  const { rows } = await query(
    `INSERT INTO freight_lanes (origin, destination, carrier_id, rate_basis, rate, notes)
     VALUES ($1,$2,$3,COALESCE($4,'flat'),COALESCE($5,0),$6) RETURNING *`,
    [origin.trim(), destination.trim(), carrierId || null, rateBasis, rate, notes || null]
  );
  res.status(201).json(rows[0]);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { origin, destination, carrierId, rateBasis, rate, notes } = req.body || {};
  if (rateBasis !== undefined && !BASES.includes(rateBasis)) return res.status(400).json({ error: `rateBasis must be one of ${BASES.join(", ")}` });
  const { rows } = await query(
    `UPDATE freight_lanes SET origin = COALESCE($2, origin), destination = COALESCE($3, destination), carrier_id = COALESCE($4, carrier_id),
       rate_basis = COALESCE($5, rate_basis), rate = COALESCE($6, rate), notes = COALESCE($7, notes) WHERE id = $1 RETURNING *`,
    [req.params.id, origin ?? null, destination ?? null, carrierId ?? null, rateBasis ?? null, rate ?? null, notes ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const { rowCount } = await query("DELETE FROM freight_lanes WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

module.exports = router;
