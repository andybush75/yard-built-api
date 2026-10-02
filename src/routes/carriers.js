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

module.exports = router;
