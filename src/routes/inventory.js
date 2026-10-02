const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/balances", requireAuth, async (req, res) => {
  const { yard, commodity } = req.query;
  const clauses = [];
  const params = [];
  if (yard) { params.push(yard); clauses.push(`yard = $${params.length}`); }
  if (commodity) { params.push(commodity); clauses.push(`commodity = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query(`SELECT * FROM inventory_balances ${where} ORDER BY yard, commodity`, params);
  res.json(rows);
});

router.get("/ledger", requireAuth, async (req, res) => {
  const { yard, commodity, limit } = req.query;
  const clauses = [];
  const params = [];
  if (yard) { params.push(yard); clauses.push(`yard = $${params.length}`); }
  if (commodity) { params.push(commodity); clauses.push(`commodity = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 200, 2000));
  const { rows } = await query(
    `SELECT * FROM inventory_ledger ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

router.get("/negative", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM inventory_balances WHERE qty < 0 ORDER BY yard, commodity");
  res.json(rows);
});

module.exports = router;
