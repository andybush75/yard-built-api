const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM remittances ORDER BY date DESC, created_at DESC");
  for (const r of rows) {
    const { rows: lines } = await query("SELECT * FROM remittance_lines WHERE remittance_id = $1", [r.id]);
    r.lines = lines;
  }
  res.json(rows);
});

// Combines one or more open ticket lines for a single payee into one check/ACH, same as "print a
// remittance that pays multiple closed-but-unpaid tickets at once" — marks each ticket paid in the
// same transaction so a line can never be double-paid by a second concurrent remittance run.
// Cutting a check is the cashier/AP job (payRemittances), not something a scale operator can do.
router.post("/", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { payee, method, checkNumber, account, date, ticketIds } = req.body || {};
  if (!payee || !method || !account || !date || !Array.isArray(ticketIds) || !ticketIds.length) {
    return res.status(400).json({ error: "payee, method, account, date, and a non-empty ticketIds array are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: tickets } = await client.query(
      `SELECT * FROM tickets WHERE id = ANY($1::text[]) AND paid = false FOR UPDATE`,
      [ticketIds]
    );
    if (tickets.length !== ticketIds.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "One or more tickets are missing or already paid" });
    }
    const total = tickets.reduce((s, t) => s + parseFloat(t.total), 0);

    const { rows: remRows } = await client.query(
      `INSERT INTO remittances (payee, method, check_number, account, date, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [payee, method, checkNumber || null, account, date, Math.round(total * 100) / 100]
    );
    const remittance = remRows[0];

    for (const t of tickets) {
      await client.query(
        "INSERT INTO remittance_lines (remittance_id, kind, ref_id, amount) VALUES ($1,'ticket',$2,$3)",
        [remittance.id, t.id, t.total]
      );
      await client.query("UPDATE tickets SET paid = true, remittance_id = $2 WHERE id = $1", [t.id, remittance.id]);
    }

    await client.query("COMMIT");
    const { rows: lines } = await query("SELECT * FROM remittance_lines WHERE remittance_id = $1", [remittance.id]);
    res.status(201).json({ ...remittance, lines });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Reprints go through void, so this needs the same permission as cutting the check in the first
// place. A remittance can only be voided once — a second void would otherwise re-open tickets that
// may already have been paid again on a replacement remittance.
router.post("/:id/void", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query("SELECT voided FROM remittances WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!existing.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (existing[0].voided) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Remittance is already voided" }); }
    const { rows } = await client.query("UPDATE remittances SET voided = true WHERE id = $1 RETURNING *", [req.params.id]);
    await client.query(
      "UPDATE tickets SET paid = false, remittance_id = NULL WHERE remittance_id = $1",
      [req.params.id]
    );
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
