const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { logAudit } = require("../audit");
const { createRemittance } = require("../remittanceService");

const router = express.Router();

// Turns a thrown error with a .status (from remittanceService) into a 4xx; rethrows anything else.
function sendIfClientError(res, err) {
  if (err.status) { res.status(err.status).json({ error: err.message }); return true; }
  return false;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Ticket status is one of Held (waiting at the cashier), Closed (done; `paid` says whether the
// check has been cut), or Voided. Filters cover what the Cashier queue, AP, and search need.
router.get("/", requireAuth, async (req, res) => {
  const { yard, type, commodity, status, paid, vendorId, customerId, q, limit } = req.query;
  const clauses = [];
  const params = [];
  if (yard) { params.push(yard); clauses.push(`yard = $${params.length}`); }
  if (type) { params.push(type); clauses.push(`type = $${params.length}`); }
  if (commodity) { params.push(commodity); clauses.push(`commodity = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (paid === "true" || paid === "false") { params.push(paid === "true"); clauses.push(`paid = $${params.length}`); }
  if (vendorId) { params.push(vendorId); clauses.push(`vendor_id = $${params.length}`); }
  if (customerId) { params.push(customerId); clauses.push(`customer_id = $${params.length}`); }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    clauses.push(`(id ILIKE $${params.length} OR party_name ILIKE $${params.length} OR hold_desc ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 200, 1000));
  const { rows } = await query(
    `SELECT * FROM tickets ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

// The whole story of one ticket on one call: the ticket, who it's with, the check it was paid on,
// and the timeline (every action anyone took on it, with their name).
router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT t.*,
            cb.name AS created_by_name, cl.name AS closed_by_name, vb.name AS voided_by_name,
            v.name AS vendor_name, v.phone AS vendor_phone, v.tier AS vendor_tier,
            c.name AS customer_name, c.phone AS customer_phone
     FROM tickets t
     LEFT JOIN users cb ON cb.id = t.created_by
     LEFT JOIN users cl ON cl.id = t.closed_by
     LEFT JOIN users vb ON vb.id = t.voided_by
     LEFT JOIN vendors v ON v.id = t.vendor_id
     LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const ticket = rows[0];
  let remittance = null;
  if (ticket.remittance_id) {
    const { rows: rem } = await query("SELECT * FROM remittances WHERE id = $1", [ticket.remittance_id]);
    remittance = rem[0] || null;
  }
  const { rows: timeline } = await query(
    `SELECT a.id, a.action, a.details, a.created_at, u.name AS user_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity = 'ticket' AND a.entity_id = $1
     ORDER BY a.created_at`,
    [req.params.id]
  );
  res.json({ ...ticket, remittance, timeline });
});

function nowTimeLabel() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// The one route that matters most for "real backend + database": creating a ticket and posting
// its effect on inventory happens inside a single DB transaction with the inventory row locked
// (SELECT ... FOR UPDATE), so two scale operators posting tickets for the same yard/commodity at
// the same moment can never race each other into a wrong moving-average cost — the exact class of
// bug the in-memory prototype can't prevent once more than one person uses it at once.
//
// Buy tickets post as Held and wait at the Cashier (Pay / Pay Later). Sell tickets post Closed.
router.post("/", requireAuth, async (req, res) => {
  const {
    id, type, date, yard, vendorId, customerId, partyName, holdDesc,
    commodity, tier, netWeight, price, payment, contractId, poId, shipmentId,
  } = req.body || {};

  if (!type || !["buy", "sell"].includes(type)) return res.status(400).json({ error: "type must be 'buy' or 'sell'" });
  if (!date || !yard || !commodity || !netWeight || price === undefined || !payment) {
    return res.status(400).json({ error: "date, yard, commodity, netWeight, price, and payment are required" });
  }
  if (!["Check", "ACH"].includes(payment)) return res.status(400).json({ error: "payment must be Check or ACH" });
  if (!partyName && !vendorId && !customerId) {
    return res.status(400).json({ error: "vendorId, customerId, or a Walk-in partyName/holdDesc is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // A linked vendor/customer must be a real row. Its name is snapshotted onto the ticket when the
    // caller didn't send one, so a ticket always carries a party_name even if the record is renamed.
    let snapshotName = partyName || null;
    if (vendorId) {
      const { rows } = await client.query("SELECT name FROM vendors WHERE id = $1", [vendorId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "vendorId does not match any vendor" }); }
      snapshotName = snapshotName || rows[0].name;
    }
    if (customerId) {
      const { rows } = await client.query("SELECT name FROM customers WHERE id = $1", [customerId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "customerId does not match any customer" }); }
      snapshotName = snapshotName || rows[0].name;
    }

    let ticketId = id;
    if (!ticketId) {
      const seqName = type === "buy" ? "ticket_buy_seq" : "ticket_sell_seq";
      const prefix = type === "buy" ? "B" : "S";
      const { rows: seqRows } = await client.query(`SELECT nextval($1) AS n`, [seqName]);
      ticketId = `${prefix}-${seqRows[0].n}`;
    }

    const { rows: existing } = await client.query("SELECT 1 FROM inventory_balances WHERE yard = $1 AND commodity = $2 FOR UPDATE", [yard, commodity]);
    let inv;
    if (!existing.length) {
      const { rows } = await client.query(
        "INSERT INTO inventory_balances (yard, commodity, qty, avg_cost) VALUES ($1,$2,0,0) RETURNING *",
        [yard, commodity]
      );
      inv = rows[0];
    } else {
      const { rows } = await client.query("SELECT * FROM inventory_balances WHERE yard = $1 AND commodity = $2", [yard, commodity]);
      inv = rows[0];
    }

    const qty = parseFloat(inv.qty);
    const avgCost = parseFloat(inv.avg_cost);
    const netWeightNum = parseFloat(netWeight);
    const priceNum = parseFloat(price);
    let newQty, newAvgCost, cogsPerLb = null, ledgerType;

    if (type === "buy") {
      newQty = qty + netWeightNum;
      newAvgCost = newQty > 0 ? (qty * avgCost + netWeightNum * priceNum) / newQty : priceNum;
      ledgerType = "Buy";
    } else {
      newQty = qty - netWeightNum; // intentionally allowed to go negative — see the prototype's negative-inventory handling
      newAvgCost = avgCost;
      cogsPerLb = avgCost;
      ledgerType = "Sell";
    }

    await client.query(
      "UPDATE inventory_balances SET qty = $3, avg_cost = $4, updated_at = now() WHERE yard = $1 AND commodity = $2",
      [yard, commodity, newQty, newAvgCost]
    );

    const total = Math.round(netWeightNum * priceNum * 100) / 100;
    const status = type === "buy" ? "Held" : "Closed";

    const { rows: ticketRows } = await client.query(
      `INSERT INTO tickets (id, type, date, yard, vendor_id, customer_id, party_name, hold_desc, commodity, tier,
                             net_weight, price, total, payment, status, cogs_per_lb, contract_id, po_id, shipment_id,
                             created_by, closed_at, closed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        ticketId, type, date, yard, vendorId || null, customerId || null,
        snapshotName, holdDesc || null, commodity, tier || null,
        netWeightNum, priceNum, total, payment, status,
        cogsPerLb, contractId || null, poId || null, shipmentId || null,
        req.user.id, status === "Closed" ? new Date() : null, status === "Closed" ? req.user.id : null,
      ]
    );

    await client.query(
      `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date, time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        yard, commodity, ledgerType, type === "buy" ? netWeightNum : -netWeightNum,
        type === "buy" ? priceNum : null, newQty, newAvgCost, Math.round(newQty * newAvgCost * 100) / 100,
        ticketId, date, nowTimeLabel(),
      ]
    );

    if (type === "sell" && contractId) {
      await client.query("UPDATE contracts SET shipped_qty = shipped_qty + $2 WHERE id = $1", [contractId, netWeightNum]);
    }
    if (type === "buy" && poId) {
      await client.query("UPDATE purchase_orders SET received_qty = received_qty + $2 WHERE id = $1", [poId, netWeightNum]);
    }

    await logAudit(client, {
      userId: req.user.id, action: "ticket.create", entity: "ticket", entityId: ticketId,
      details: { type, yard, party: snapshotName, commodity, netWeight: netWeightNum, price: priceNum, total, status },
    });

    await client.query("COMMIT");
    res.status(201).json(ticketRows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "A ticket with that id already exists" });
    throw err;
  } finally {
    client.release();
  }
});

// Cashier: "Pay Later" — close the held ticket and send it to AP unpaid, to be covered by a
// remittance run later. Walk-ins are excluded from AP (business rule), so they must be paid here.
router.post("/:id/pay-later", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    const t = rows[0];
    if (t.type !== "buy") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Only buy tickets go through the cashier" }); }
    if (t.status !== "Held") { await client.query("ROLLBACK"); return res.status(409).json({ error: `Ticket is ${t.status}, not Held` }); }
    if (!t.vendor_id) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Walk-ins can't be sent to AP — pay them at the cashier, or add them as a dealer first" }); }
    const { rows: updated } = await client.query(
      "UPDATE tickets SET status = 'Closed', closed_at = now(), closed_by = $2 WHERE id = $1 RETURNING *",
      [t.id, req.user.id]
    );
    await logAudit(client, { userId: req.user.id, action: "ticket.close", entity: "ticket", entityId: t.id, details: { mode: "pay_later" } });
    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Cashier: "Pay" — cut a one-line check/ACH for this ticket right now. Closes it and pays it in
// one step. A walk-in has no dealer record, so the cashier types who the check is made out to.
// (The ID-scan / fingerprint verification step will attach here; it is not built yet.)
router.post("/:id/pay", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { method, checkNumber, account, payee, date } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    const t = rows[0];
    if (t.type !== "buy") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Only buy tickets are paid" }); }
    if (t.status === "Voided") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Ticket is voided" }); }
    if (t.paid) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Ticket is already paid" }); }
    const finalPayee = (payee && payee.trim()) || (t.vendor_id ? t.party_name : null);
    if (!finalPayee) { await client.query("ROLLBACK"); return res.status(400).json({ error: "payee is required for a walk-in — who is the check made out to?" }); }

    const remittance = await createRemittance(client, {
      payee: finalPayee, method: method || t.payment, checkNumber, account: account || t.yard,
      date: date || todayIso(), ticketIds: [t.id], userId: req.user.id, source: "cashier",
    });
    const { rows: updated } = await client.query("SELECT * FROM tickets WHERE id = $1", [t.id]);
    await client.query("COMMIT");
    res.json({ ticket: updated[0], remittance });
  } catch (err) {
    await client.query("ROLLBACK");
    if (sendIfClientError(res, err)) return;
    throw err;
  } finally {
    client.release();
  }
});

// Void a ticket: reverses its inventory effect and marks it Voided. A paid ticket must have its
// remittance voided first, so money and material never disagree about what happened.
router.post("/:id/void", requireAuth, requirePermission("voidTickets"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "reason is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    const t = rows[0];
    if (t.status === "Voided") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Ticket is already voided" }); }
    if (t.paid) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Ticket has been paid — void its remittance first" }); }

    const { rows: invRows } = await client.query("SELECT * FROM inventory_balances WHERE yard = $1 AND commodity = $2 FOR UPDATE", [t.yard, t.commodity]);
    const inv = invRows[0] || { qty: 0, avg_cost: 0 };
    const net = parseFloat(t.net_weight);
    // Put the material back the way it was: a voided buy leaves inventory, a voided sell returns.
    // The moving-average cost is left as-is — it is a running estimate, and re-deriving it from
    // history would make a void change costs on tickets written since.
    const newQty = parseFloat(inv.qty) + (t.type === "buy" ? -net : net);
    const avgCost = parseFloat(inv.avg_cost);
    await client.query(
      `INSERT INTO inventory_balances (yard, commodity, qty, avg_cost) VALUES ($1,$2,$3,$4)
       ON CONFLICT (yard, commodity) DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`,
      [t.yard, t.commodity, newQty, avgCost]
    );
    await client.query(
      `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date, time)
       VALUES ($1,$2,'Void',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.yard, t.commodity, t.type === "buy" ? -net : net, t.price, newQty, avgCost,
       Math.round(newQty * avgCost * 100) / 100, t.id, todayIso(), nowTimeLabel()]
    );
    if (t.type === "sell" && t.contract_id) {
      await client.query("UPDATE contracts SET shipped_qty = shipped_qty - $2 WHERE id = $1", [t.contract_id, net]);
    }
    if (t.type === "buy" && t.po_id) {
      await client.query("UPDATE purchase_orders SET received_qty = received_qty - $2 WHERE id = $1", [t.po_id, net]);
    }
    const { rows: updated } = await client.query(
      "UPDATE tickets SET status = 'Voided', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 RETURNING *",
      [t.id, req.user.id, reason.trim()]
    );
    await logAudit(client, { userId: req.user.id, action: "ticket.void", entity: "ticket", entityId: t.id, details: { reason: reason.trim(), previousStatus: t.status } });
    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
