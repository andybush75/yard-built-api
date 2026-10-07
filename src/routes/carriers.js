const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM carriers ORDER BY name");
  res.json(rows);
});

router.post("/", requireAuth, async (req, res) => {
  const { name, phone, mc, notes, type, isContainerTruck, assetId } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const { rows } = await query(
    `INSERT INTO carriers (name, phone, mc, notes, type, is_container_truck, asset_id)
     VALUES ($1,$2,$3,$4,COALESCE($5,'common'),COALESCE($6,false),$7) RETURNING *`,
    [name, phone, mc, notes, type, isContainerTruck, assetId]
  );
  res.status(201).json(rows[0]);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { name, phone, mc, notes, type, isContainerTruck, assetId } = req.body || {};
  if (type !== undefined && !["owned", "common", "dedicated"].includes(type)) return res.status(400).json({ error: "type must be owned, common, or dedicated" });
  const { rows } = await query(
    `UPDATE carriers SET name = COALESCE($2, name), phone = COALESCE($3, phone), mc = COALESCE($4, mc), notes = COALESCE($5, notes),
       type = COALESCE($6, type), is_container_truck = COALESCE($7, is_container_truck), asset_id = COALESCE($8, asset_id)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name ?? null, phone ?? null, mc ?? null, notes ?? null, type ?? null, isContainerTruck ?? null, assetId ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
