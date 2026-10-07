const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { logAudit } = require("../audit");
const { createRemittance } = require("../remittanceService");

const router = express.Router();

const SELECT_WITH_LINES = `
  SELECT r.*, cb.name AS created_by_name, vb.name AS voided_by_name,
         COALESCE(json_agg(l.* ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
  FROM remittances r
  LEFT JOIN remittance_lines l ON l.remittance_id = r.id
  LEFT JOIN users cb ON cb.id = r.created_by
  LEFT JOIN users vb ON vb.id = r.voided_by`;

router.get("/", requireAuth, async (req, res) => {
  const { account, payee, voided, limit } = req.query;
  const clauses = [];
  const params = [];
  if (account) { params.push(account); clauses.push(`r.account = $${params.length}`); }
  if (payee) { params.push(payee); clauses.push(`r.payee = $${params.length}`); }
  if (voided === "true" || voided === "false") { params.push(voided === "true"); clauses.push(`r.voided = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 500, 2000));
  const { rows } = await query(
    `${SELECT_WITH_LINES} ${where} GROUP BY r.id, cb.name, vb.name ORDER BY r.date DESC, r.created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(`${SELECT_WITH_LINES} WHERE r.id = $1 GROUP BY r.id, cb.name, vb.name`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// AP remittance run: one check/ACH covering one or more closed-but-unpaid buy tickets for a payee.
// Cutting a check is the cashier/AP job (payRemittances), not something a scale operator can do.
router.post("/", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { payee, method, checkNumber, account, date, ticketIds } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const remittance = await createRemittance(client, {
      payee, method, checkNumber, account, date, ticketIds, userId: req.user.id, source: "ap_run",
    });
    await client.query("COMMIT");
    res.status(201).json(remittance);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// Check-register bookkeeping: printed / check printed / emailed / cleared. These never move money,
// but the register's "outstanding vs cleared" balances depend on them.
router.patch("/:id", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { printed, checkPrinted, emailed, cleared, clearedDate } = req.body || {};
  const { rows: existing } = await query("SELECT voided FROM remittances WHERE id = $1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Not found" });
  if (existing[0].voided) return res.status(409).json({ error: "Remittance is voided" });
  const { rows } = await query(
    `UPDATE remittances SET
       printed = COALESCE($2, printed), check_printed = COALESCE($3, check_printed), emailed = COALESCE($4, emailed),
       cleared = COALESCE($5, cleared),
       cleared_date = CASE WHEN $5 = false THEN NULL ELSE COALESCE($6, cleared_date) END
     WHERE id = $1 RETURNING *`,
    [req.params.id, printed ?? null, checkPrinted ?? null, emailed ?? null, cleared ?? null, clearedDate || null]
  );
  await logAudit(pool, { userId: req.user.id, action: "remittance.update", entity: "remittance", entityId: req.params.id, details: req.body });
  res.json(rows[0]);
});

// Reprints go through void, so this needs the same permission as cutting the check in the first
// place. A remittance can only be voided once — a second void would otherwise re-open tickets that
// may already have been paid again on a replacement remittance. The tickets go back to Closed /
// unpaid so a fresh remittance can cover them.
router.post("/:id/void", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { reason } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query("SELECT * FROM remittances WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!existing.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (existing[0].voided) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Remittance is already voided" }); }
    const { rows } = await client.query(
      `UPDATE remittances SET voided = true, voided_at = now(), voided_by = $2, void_reason = $3, cleared = false, cleared_date = NULL
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.user.id, reason ? reason.trim() : null]
    );
    const { rows: tickets } = await client.query(
      "UPDATE tickets SET paid = false, remittance_id = NULL WHERE remittance_id = $1 RETURNING id",
      [req.params.id]
    );
    for (const t of tickets) {
      await logAudit(client, { userId: req.user.id, action: "ticket.unpay", entity: "ticket", entityId: t.id, details: { remittanceId: req.params.id, reason: reason || null } });
    }
    await logAudit(client, { userId: req.user.id, action: "remittance.void", entity: "remittance", entityId: req.params.id, details: { reason: reason || null, ticketIds: tickets.map((t) => t.id) } });
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
