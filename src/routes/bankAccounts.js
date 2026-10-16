const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const fieldCrypto = require("../fieldCrypto");
const { normalizeConfig } = require("../positivePayFormat");

const router = express.Router();

// The full account number is encrypted at rest and never returned — only whether one is on file.
function publicRow(a) {
  return {
    yard: a.yard, bank_name: a.bank_name, last4: a.last4, starting_balance: a.starting_balance, next_check_number: a.next_check_number,
    routing_number: a.routing_number || null, has_account_number: !!a.account_number_enc,
    positive_pay_enabled: !!a.positive_pay_enabled, positive_pay_config: a.positive_pay_config || null,
    encryption_configured: fieldCrypto.configured(),
  };
}

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM bank_accounts ORDER BY yard");
  res.json(rows.map(publicRow));
});

// Admin only (editBankAccounts): opening balance, next check number, bank name, routing/account
// numbers and the positive-pay layout for this account.
router.patch("/:yard", requireAuth, requirePermission("editBankAccounts"), async (req, res) => {
  const { startingBalance, nextCheckNumber, bankName, routingNumber, accountNumber, positivePayEnabled, positivePayConfig } = req.body || {};
  const sets = []; const params = [req.params.yard];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (startingBalance !== undefined) { if (typeof startingBalance !== "number" || !isFinite(startingBalance)) return res.status(400).json({ error: "startingBalance must be a number" }); push("starting_balance", startingBalance); }
  if (nextCheckNumber !== undefined) { if (!(Number.isInteger(nextCheckNumber) && nextCheckNumber > 0)) return res.status(400).json({ error: "nextCheckNumber must be a positive whole number" }); push("next_check_number", nextCheckNumber); }
  if (bankName !== undefined) { const n = String(bankName).trim(); if (!n) return res.status(400).json({ error: "bankName can't be blank" }); push("bank_name", n.slice(0, 80)); }
  if (routingNumber !== undefined) {
    const r = String(routingNumber).replace(/\D/g, "");
    if (r && r.length !== 9) return res.status(400).json({ error: "Routing numbers are 9 digits" });
    push("routing_number", r || null);
  }
  if (accountNumber !== undefined) {
    const n = String(accountNumber).replace(/[\s-]/g, "");
    if (n && !/^\d{4,17}$/.test(n)) return res.status(400).json({ error: "Account number should be 4–17 digits" });
    if (n) {
      try { push("account_number_enc", fieldCrypto.encrypt(n, "bank account numbers")); } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
      push("last4", n.slice(-4));
    } else push("account_number_enc", null);
  }
  if (positivePayEnabled !== undefined) push("positive_pay_enabled", !!positivePayEnabled);
  if (positivePayConfig !== undefined) {
    if (positivePayConfig === null) push("positive_pay_config", null);
    else {
      const { config, errors } = normalizeConfig(positivePayConfig);
      if (errors.length) return res.status(400).json({ error: errors.join("; ") });
      push("positive_pay_config", JSON.stringify(config));
    }
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

  const { rows } = await query(`UPDATE bank_accounts SET ${sets.join(", ")} WHERE yard = $1 RETURNING *`, params);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(publicRow(rows[0]));
});

module.exports = router;
