const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { logAudit } = require("../audit");
const { createTransfer, voidTransfer, transferPrice } = require("../transferService");

const router = express.Router();
const SELECT = `SELECT x.*, cb.name AS created_by_name, rb.name AS reconciled_by_name
                FROM yard_transfers x LEFT JOIN users cb ON cb.id = x.created_by LEFT JOIN users rb ON rb.id = x.reconciled_by`;

router.get("/", requireAuth, async (req, res) => {
  const { yard, status, limit } = req.query;
  const clauses = []; const params = [];
  if (yard) { params.push(yard); clauses.push(`(x.from_yard = $${params.length} OR x.to_yard = $${params.length})`); }
  if (status) { params.push(status); clauses.push(`x.status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 500, 2000));
  const { rows } = await query(`${SELECT} ${where} ORDER BY x.date DESC, x.created_at DESC LIMIT $${params.length}`, params);
  res.json(rows);
});

// Price preview for the form: what would this transfer price out at right now?
router.get("/price", requireAuth, async (req, res) => {
  const { commodity, fromYard, marginBasis, marginValue } = req.query;
  const client = await pool.connect();
  try {
    const price = await transferPrice(client, commodity, fromYard, marginBasis || "pct", parseFloat(marginValue) || 0);
    res.json({ price });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally { client.release(); }
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(`${SELECT} WHERE x.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

router.post("/", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: yards } = await client.query("SELECT code, name FROM yards");
    const yardNames = Object.fromEntries(yards.map((y) => [y.code, y.name]));
    const x = await createTransfer(client, { ...(req.body || {}), userId: req.user.id, yardNames });
    await client.query("COMMIT");
    res.status(201).json(x);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally { client.release(); }
});

// Both yards have reviewed and agree — a settlement checkmark, not a cash movement.
router.post("/:id/reconcile", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { rows: cur } = await query("SELECT status FROM yard_transfers WHERE id = $1", [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: "Not found" });
  if (cur[0].status !== "Open") return res.status(409).json({ error: `Transfer is ${cur[0].status}` });
  const { rows } = await query(
    "UPDATE yard_transfers SET status = 'Reconciled', reconciled_at = now(), reconciled_by = $2 WHERE id = $1 RETURNING *",
    [req.params.id, req.user.id]
  );
  await logAudit(pool, { userId: req.user.id, action: "transfer.reconcile", entity: "transfer", entityId: req.params.id });
  res.json(rows[0]);
});

router.post("/:id/void", requireAuth, requirePermission("voidTickets"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "reason is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const x = await voidTransfer(client, { id: req.params.id, reason: reason.trim(), userId: req.user.id });
    await client.query("COMMIT");
    res.json(x);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally { client.release(); }
});

module.exports = router;
