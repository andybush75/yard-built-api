const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM vendors ORDER BY name");
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM vendors WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.post("/", requireAuth, async (req, res) => {
  const { name, phone, email, tier, notes, smartphone, onPriceList, autoSend } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const { rows } = await query(
    `INSERT INTO vendors (name, phone, email, tier, notes, smartphone, on_price_list, auto_send)
     VALUES ($1,$2,$3,COALESCE($4,'scale'),$5,COALESCE($6,false),COALESCE($7,false),COALESCE($8,'off'))
     RETURNING *`,
    [name, phone, email, tier, notes, smartphone, onPriceList, autoSend]
  );
  res.status(201).json(rows[0]);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { name, phone, email, tier, notes, smartphone, onPriceList, autoSend } = req.body || {};
  const { rows } = await query(
    `UPDATE vendors SET
       name = COALESCE($2, name), phone = COALESCE($3, phone), email = COALESCE($4, email),
       tier = COALESCE($5, tier), notes = COALESCE($6, notes), smartphone = COALESCE($7, smartphone),
       on_price_list = COALESCE($8, on_price_list), auto_send = COALESCE($9, auto_send)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name, phone, email, tier, notes, smartphone, onPriceList, autoSend]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
