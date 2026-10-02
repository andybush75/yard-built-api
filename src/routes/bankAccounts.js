const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM bank_accounts ORDER BY yard");
  res.json(rows);
});

router.patch("/:yard", requireAuth, async (req, res) => {
  const { startingBalance } = req.body || {};
  if (startingBalance === undefined) return res.status(400).json({ error: "startingBalance is required" });
  const { rows } = await query(
    "UPDATE bank_accounts SET starting_balance = $2 WHERE yard = $1 RETURNING *",
    [req.params.yard, startingBalance]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
