const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM bank_accounts ORDER BY yard");
  res.json(rows);
});

// The starting balance is the yard's cash figure, and the next check number must match the check
// stock in the drawer — admin only (editBankAccounts).
router.patch("/:yard", requireAuth, requirePermission("editBankAccounts"), async (req, res) => {
  const { startingBalance, nextCheckNumber } = req.body || {};
  if (startingBalance === undefined && nextCheckNumber === undefined) {
    return res.status(400).json({ error: "startingBalance or nextCheckNumber is required" });
  }
  if (nextCheckNumber !== undefined && !(Number.isInteger(nextCheckNumber) && nextCheckNumber > 0)) {
    return res.status(400).json({ error: "nextCheckNumber must be a positive whole number" });
  }
  const { rows } = await query(
    `UPDATE bank_accounts SET starting_balance = COALESCE($2, starting_balance), next_check_number = COALESCE($3, next_check_number)
     WHERE yard = $1 RETURNING *`,
    [req.params.yard, startingBalance ?? null, nextCheckNumber ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
