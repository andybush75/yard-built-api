// Freight tickets: a carrier cost attached to one scale ticket. The money rules (from the brief):
//   - Inbound freight (on a BUY) is a landed cost: capitalized into that commodity's moving-average
//     inventory cost at that yard, spread over the load's own weight. Only the delta since the last
//     capitalization is applied, so reconciling a $0.01 placeholder adds the difference once.
//   - Outbound freight (on a SELL) is never capitalized — it's an AP / period cost.
//   - A $0.01 placeholder means "freight is owed, the amount isn't known yet" (status Estimated).
//   - One live freight ticket per scale ticket (unique index; voided ones don't count).
// All functions run inside the caller's transaction and throw errors with a .status for 4xx.
const { logAudit } = require("./audit");

function fail(status, message) { const e = new Error(message); e.status = status; return e; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function nowTimeLabel() { return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }

// Applies (cost - capitalized_amount) to the inventory cost basis for an inbound freight ticket.
// Returns the ledger entry written, or null if nothing changed. Caller passes the locked ticket row.
async function capitalizeInbound(client, freight, ticket, userId) {
  if (ticket.type !== "buy") {
    await client.query("UPDATE freight_tickets SET capitalized_note = NULL WHERE id = $1", [freight.id]);
    return null;
  }
  const delta = Math.round((parseFloat(freight.cost) - parseFloat(freight.capitalized_amount || 0)) * 100) / 100;
  if (Math.abs(delta) < 0.005) return null;
  const { rows } = await client.query("SELECT * FROM inventory_balances WHERE yard = $1 AND commodity = $2 FOR UPDATE", [ticket.yard, ticket.commodity]);
  const inv = rows[0];
  if (!inv || parseFloat(inv.qty) <= 0) {
    await client.query("UPDATE freight_tickets SET capitalized_note = $2 WHERE id = $1",
      [freight.id, `Not capitalized — no ${ticket.commodity} on hand at ${ticket.yard} to carry the cost`]);
    return null;
  }
  const qty = parseFloat(inv.qty);
  const newAvg = (qty * parseFloat(inv.avg_cost) + delta) / qty;
  await client.query("UPDATE inventory_balances SET avg_cost = $3, updated_at = now() WHERE yard = $1 AND commodity = $2", [ticket.yard, ticket.commodity, newAvg]);
  const { rows: led } = await client.query(
    `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date, time)
     VALUES ($1,$2,'Freight-in',0,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ticket.yard, ticket.commodity, delta / qty, qty, newAvg, Math.round(qty * newAvg * 100) / 100, freight.id, todayIso(), nowTimeLabel()]
  );
  await client.query("UPDATE freight_tickets SET capitalized_amount = $2, capitalized_note = NULL WHERE id = $1", [freight.id, parseFloat(freight.cost)]);
  await logAudit(client, { userId, action: "ticket.freight_capitalize", entity: "ticket", entityId: ticket.id, details: { freightId: freight.id, amount: delta, newAvgCost: newAvg } });
  return led[0];
}

async function createFreight(client, { ticketId, carrierId, laneId, origin, destination, cost, placeholder, notes, date, userId }) {
  if (!ticketId) throw fail(400, "ticketId is required");
  const { rows: tk } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
  if (!tk.length) throw fail(404, `Ticket ${ticketId} not found`);
  const ticket = tk[0];
  if (ticket.status === "Voided") throw fail(409, `${ticketId} is voided`);
  if (carrierId) {
    const { rows } = await client.query("SELECT id FROM carriers WHERE id = $1", [carrierId]);
    if (!rows.length) throw fail(400, "carrierId does not match any carrier");
  }
  const finalCost = placeholder ? 0.01 : parseFloat(cost);
  if (!placeholder && !(finalCost > 0)) throw fail(400, "cost must be greater than zero, or send placeholder: true");
  const { rows: existing } = await client.query("SELECT id FROM freight_tickets WHERE ticket_id = $1 AND voided_at IS NULL", [ticketId]);
  if (existing.length) throw fail(409, `${ticketId} already has freight ticket ${existing[0].id} — each scale ticket carries one freight ticket`);
  const { rows } = await client.query(
    `INSERT INTO freight_tickets (ticket_id, carrier_id, lane_id, origin, destination, cost, status, date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ticketId, carrierId || null, laneId || null, origin || "TBD", destination || "TBD", finalCost,
     placeholder ? "Estimated" : "Reconciled", date || todayIso(), notes || null, userId || null]
  );
  const freight = rows[0];
  if (!placeholder) { freight.reconciled_at = new Date(); await client.query("UPDATE freight_tickets SET reconciled_at = now(), reconciled_by = $2 WHERE id = $1", [freight.id, userId || null]); }
  const ledgerEntry = await capitalizeInbound(client, freight, ticket, userId);
  await logAudit(client, { userId, action: "ticket.freight_attach", entity: "ticket", entityId: ticketId, details: { freightId: freight.id, carrierId: carrierId || null, cost: finalCost, placeholder: !!placeholder, origin: freight.origin, destination: freight.destination } });
  await logAudit(client, { userId, action: "freight.create", entity: "freight", entityId: freight.id, details: { ticketId, cost: finalCost, placeholder: !!placeholder } });
  const { rows: out } = await client.query("SELECT * FROM freight_tickets WHERE id = $1", [freight.id]);
  return { freight: out[0], ledgerEntry };
}

async function reconcileFreight(client, { id, cost, carrierId, userId }) {
  const { rows } = await client.query("SELECT * FROM freight_tickets WHERE id = $1 FOR UPDATE", [id]);
  if (!rows.length) throw fail(404, "Not found");
  const f = rows[0];
  if (f.voided_at) throw fail(409, "Freight ticket is voided");
  if (f.paid) throw fail(409, "Freight ticket is already paid — void the remittance first");
  const finalCost = parseFloat(cost);
  if (!(finalCost > 0)) throw fail(400, "cost must be greater than zero");
  if (carrierId) {
    const { rows: c } = await client.query("SELECT id FROM carriers WHERE id = $1", [carrierId]);
    if (!c.length) throw fail(400, "carrierId does not match any carrier");
  }
  const { rows: tk } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [f.ticket_id]);
  await client.query(
    `UPDATE freight_tickets SET cost = $2, status = 'Reconciled', reconciled_at = now(), reconciled_by = $3, carrier_id = COALESCE($4, carrier_id) WHERE id = $1`,
    [id, finalCost, userId || null, carrierId || null]
  );
  const updated = { ...f, cost: finalCost };
  const ledgerEntry = await capitalizeInbound(client, updated, tk[0], userId);
  await logAudit(client, { userId, action: "ticket.freight_reconcile", entity: "ticket", entityId: f.ticket_id, details: { freightId: id, from: parseFloat(f.cost), to: finalCost } });
  await logAudit(client, { userId, action: "freight.reconcile", entity: "freight", entityId: id, details: { from: parseFloat(f.cost), to: finalCost } });
  const { rows: out } = await client.query("SELECT * FROM freight_tickets WHERE id = $1", [id]);
  return { freight: out[0], ledgerEntry };
}

// Voiding takes any capitalized amount back out of inventory cost (negative delta), so a mistaken
// freight ticket doesn't leave a phantom cost behind.
async function voidFreight(client, { id, reason, userId }) {
  const { rows } = await client.query("SELECT * FROM freight_tickets WHERE id = $1 FOR UPDATE", [id]);
  if (!rows.length) throw fail(404, "Not found");
  const f = rows[0];
  if (f.voided_at) throw fail(409, "Freight ticket is already voided");
  if (f.paid) throw fail(409, "Freight ticket has been paid — void the remittance first");
  const { rows: tk } = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [f.ticket_id]);
  let ledgerEntry = null;
  if (parseFloat(f.capitalized_amount) > 0) {
    ledgerEntry = await capitalizeInbound(client, { ...f, cost: 0 }, tk[0], userId);
    await client.query("UPDATE freight_tickets SET capitalized_amount = 0 WHERE id = $1", [id]);
  }
  await client.query("UPDATE freight_tickets SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [id, userId || null, reason]);
  await logAudit(client, { userId, action: "ticket.freight_void", entity: "ticket", entityId: f.ticket_id, details: { freightId: id, reason } });
  await logAudit(client, { userId, action: "freight.void", entity: "freight", entityId: id, details: { reason } });
  const { rows: out } = await client.query("SELECT * FROM freight_tickets WHERE id = $1", [id]);
  return { freight: out[0], ledgerEntry };
}

module.exports = { createFreight, reconcileFreight, voidFreight, capitalizeInbound };
