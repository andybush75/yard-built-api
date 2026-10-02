const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { category } = req.query;
  const { rows } = category
    ? await query("SELECT * FROM commodities WHERE category = $1 ORDER BY name", [category])
    : await query("SELECT * FROM commodities ORDER BY category, name");
  res.json(rows);
});

router.get("/:code", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM commodities WHERE code = $1", [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.post("/", requireAuth, requirePermission("addCommodity"), async (req, res) => {
  const { code, name, category, ferrous, unit, lowThreshold, masterPrice, kioskShow, kioskColor, askPrice } = req.body || {};
  if (!code || !name || !category) return res.status(400).json({ error: "code, name, and category are required" });
  try {
    const { rows } = await query(
      `INSERT INTO commodities (code, name, category, ferrous, unit, low_threshold, master_price, kiosk_show, kiosk_color, ask_price)
       VALUES ($1,$2,$3,COALESCE($4,false),COALESCE($5,'lb'),COALESCE($6,0),COALESCE($7,0),COALESCE($8,true),$9,COALESCE($10,false))
       RETURNING *`,
      [code, name, category, ferrous, unit, lowThreshold, masterPrice, kioskShow, kioskColor, askPrice]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Commodity ${code} already exists` });
    throw err;
  }
});

// Editing master price / tier margins is its own permission, separate from creating a new commodity.
router.patch("/:code", requireAuth, requirePermission("editPricing"), async (req, res) => {
  const { name, category, lowThreshold, masterPrice, kioskShow, kioskColor, askPrice } = req.body || {};
  const { rows } = await query(
    `UPDATE commodities SET
       name = COALESCE($2, name),
       category = COALESCE($3, category),
       low_threshold = COALESCE($4, low_threshold),
       master_price = COALESCE($5, master_price),
       kiosk_show = COALESCE($6, kiosk_show),
       kiosk_color = COALESCE($7, kiosk_color),
       ask_price = COALESCE($8, ask_price)
     WHERE code = $1 RETURNING *`,
    [req.params.code, name, category, lowThreshold, masterPrice, kioskShow, kioskColor, askPrice]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
