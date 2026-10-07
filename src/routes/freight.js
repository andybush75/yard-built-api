const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { createFreight, reconcileFreight, voidFreight } = require("../freightService");

const router = express.Router();

const SELECT = `SELECT f.*, c.name AS carrier_name, t.type AS ticket_type, t.yard AS ticket_yard, t.commodity AS ticket_commodity, t.party_name AS ticket_party
                FROM freight_tickets f LEFT JOIN carriers c ON c.id = f.carrier_id JOIN tickets t ON t.id = f.ticket_id`;

function runInTx(res, fn) {
  return (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.status) { res.status(err.status).json({ error: err.message }); return undefined; }
      throw err;
    } finally {
      client.release();
    }
  })();
}

router.get("/", requireAuth, async (req, res) => {
  const { ticketId, carrierId, status, paid, includeVoided, limit } = req.query;
  const clauses = [];
  const params = [];
  if (ticketId) { params.push(ticketId); clauses.push(`f.ticket_id = $${params.length}`); }
  if (carrierId) { params.push(carrierId); clauses.push(`f.carrier_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`f.status = $${params.length}`); }
  if (paid === "true" || paid === "false") { params.push(paid === "true"); clauses.push(`f.paid = $${params.length}`); }
  if (includeVoided !== "true") clauses.push("f.voided_at IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 500, 2000));
  const { rows } = await query(`${SELECT} ${where} ORDER BY f.date DESC, f.created_at DESC LIMIT $${params.length}`, params);
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(`${SELECT} WHERE f.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// Attach freight to a scale ticket. Anyone who can write a ticket can attach its freight (the
// kiosk does it in the same motion). Body: ticketId, carrierId?, laneId?, origin?, destination?,
// cost | placeholder: true, notes?, date?
router.post("/", requireAuth, async (req, res) => {
  const result = await runInTx(res, (client) => createFreight(client, { ...(req.body || {}), userId: req.user.id }));
  if (result) res.status(201).json(result);
});

// Replace a $0.01 placeholder (or correct an estimate) with the carrier's real bill.
router.post("/:id/reconcile", requireAuth, async (req, res) => {
  const { cost, carrierId } = req.body || {};
  const result = await runInTx(res, (client) => reconcileFreight(client, { id: req.params.id, cost, carrierId, userId: req.user.id }));
  if (result) res.json(result);
});

// Carrier / route details can be corrected until the freight is paid.
router.patch("/:id", requireAuth, async (req, res) => {
  const { carrierId, laneId, origin, destination, notes } = req.body || {};
  const { rows: existing } = await query("SELECT paid, voided_at FROM freight_tickets WHERE id = $1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Not found" });
  if (existing[0].voided_at) return res.status(409).json({ error: "Freight ticket is voided" });
  if (existing[0].paid && carrierId !== undefined) return res.status(409).json({ error: "Freight ticket is paid — the carrier can't change" });
  if (carrierId) {
    const { rows: c } = await query("SELECT id FROM carriers WHERE id = $1", [carrierId]);
    if (!c.length) return res.status(400).json({ error: "carrierId does not match any carrier" });
  }
  await query(
    `UPDATE freight_tickets SET carrier_id = COALESCE($2, carrier_id), lane_id = COALESCE($3, lane_id), origin = COALESCE($4, origin),
       destination = COALESCE($5, destination), notes = COALESCE($6, notes) WHERE id = $1`,
    [req.params.id, carrierId ?? null, laneId ?? null, origin ?? null, destination ?? null, notes ?? null]
  );
  const { rows } = await query(`${SELECT} WHERE f.id = $1`, [req.params.id]);
  res.json(rows[0]);
});

router.post("/:id/void", requireAuth, requirePermission("voidTickets"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "reason is required" });
  const result = await runInTx(res, (client) => voidFreight(client, { id: req.params.id, reason: reason.trim(), userId: req.user.id }));
  if (result) res.json(result);
});

module.exports = router;
