const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// The one search box. Type whatever you know — a ticket number, a dealer or customer name, a
// phone number, a hold description ("silver Dodge Ram"), a check number, a dollar amount — and
// get the matching tickets, dealers, customers and checks in one answer.
router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ q, tickets: [], vendors: [], customers: [], remittances: [] });
  const like = `%${q}%`;
  const amount = /^\$?\d+(\.\d{1,2})?$/.test(q) ? parseFloat(q.replace("$", "")) : null;

  const [tickets, vendors, customers, remittances] = await Promise.all([
    query(
      `SELECT id, type, date, yard, party_name, hold_desc, commodity, net_weight, total, status, paid, remittance_id
       FROM tickets
       WHERE id ILIKE $1 OR party_name ILIKE $1 OR hold_desc ILIKE $1 ${amount !== null ? "OR total = $2" : ""}
       ORDER BY date DESC, created_at DESC LIMIT 25`,
      amount !== null ? [like, amount] : [like]
    ),
    query("SELECT id, name, phone, tier FROM vendors WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 10", [like]),
    query("SELECT id, name, phone, terms FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 10", [like]),
    query(
      `SELECT id, payee, method, check_number, account, date, total, voided
       FROM remittances WHERE check_number = $2 OR payee ILIKE $1 ${amount !== null ? "OR total = $3" : ""}
       ORDER BY date DESC LIMIT 10`,
      amount !== null ? [like, q, amount] : [like, q]
    ),
  ]);
  res.json({ q, tickets: tickets.rows, vendors: vendors.rows, customers: customers.rows, remittances: remittances.rows });
});

module.exports = router;
