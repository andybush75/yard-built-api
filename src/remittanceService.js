// Creating a remittance (one check or ACH paying one or more buy tickets) is the same whether it
// comes from the cashier's Pay button (one ticket, right now) or an AP remittance run (several
// tickets for one payee). Both routes call this inside their own transaction.
//
// Throws errors with a `.status` so the route can turn them into 4xx responses.
const { logAudit } = require("./audit");

const METHODS = ["Check", "ACH"]; // Check and ACH only — no cash, no EZCash (business rule)

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// A remittance pays buy tickets (material) and/or freight tickets (carrier bills) — one check can
// cover both for a dealer who also hauls. At least one of ticketIds / freightIds is required.
async function createRemittance(client, { payee, method, checkNumber, account, date, ticketIds = [], freightIds = [], userId, source }) {
  if (!METHODS.includes(method)) throw fail(400, "method must be Check or ACH");
  if (!payee || !payee.trim()) throw fail(400, "payee is required");
  if (!account) throw fail(400, "account (the yard whose bank account pays) is required");
  if (!date) throw fail(400, "date is required");
  if (!Array.isArray(ticketIds) || !Array.isArray(freightIds)) throw fail(400, "ticketIds and freightIds must be lists");
  if (!ticketIds.length && !freightIds.length) throw fail(400, "ticketIds or freightIds must be a non-empty list");

  // Lock the tickets so two people can't pay the same one at the same moment.
  const { rows: tickets } = ticketIds.length
    ? await client.query("SELECT * FROM tickets WHERE id = ANY($1::text[]) FOR UPDATE", [ticketIds])
    : { rows: [] };
  if (tickets.length !== ticketIds.length) throw fail(409, "One or more tickets were not found");
  for (const t of tickets) {
    if (t.type !== "buy") throw fail(400, `${t.id} is a sell ticket — only buy tickets are paid by remittance`);
    if (t.status === "Voided") throw fail(409, `${t.id} is voided`);
    if (t.paid) throw fail(409, `${t.id} is already paid`);
  }
  const { rows: freights } = freightIds.length
    ? await client.query("SELECT * FROM freight_tickets WHERE id = ANY($1::text[]) FOR UPDATE", [freightIds])
    : { rows: [] };
  if (freights.length !== freightIds.length) throw fail(409, "One or more freight tickets were not found");
  for (const f of freights) {
    if (f.voided_at) throw fail(409, `Freight ${f.id} is voided`);
    if (f.paid) throw fail(409, `Freight ${f.id} is already paid`);
    if (f.status !== "Reconciled") throw fail(409, `Freight ${f.id} is still a placeholder — reconcile it to the carrier's real bill before paying`);
    if (!f.carrier_id) throw fail(409, `Freight ${f.id} has no carrier to pay`);
  }

  // Lock the bank account so check numbers are handed out one at a time.
  const { rows: accts } = await client.query("SELECT * FROM bank_accounts WHERE yard = $1 FOR UPDATE", [account]);
  if (!accts.length) throw fail(400, `No bank account for yard ${account}`);
  let finalCheckNumber = null;
  if (method === "Check") {
    const typed = checkNumber !== undefined && checkNumber !== null && String(checkNumber).trim() !== "" ? String(checkNumber).trim() : null;
    if (typed) {
      const { rows: dup } = await client.query(
        "SELECT id FROM remittances WHERE account = $1 AND check_number = $2 AND voided = false",
        [account, typed]
      );
      if (dup.length) throw fail(409, `Check #${typed} has already been used on ${account}'s account`);
      finalCheckNumber = typed;
      // Keep the sequence ahead of any typed number so the next auto-assigned one can't collide.
      const n = parseInt(typed, 10);
      if (!isNaN(n) && n >= accts[0].next_check_number) {
        await client.query("UPDATE bank_accounts SET next_check_number = $2 WHERE yard = $1", [account, n + 1]);
      }
    } else {
      finalCheckNumber = String(accts[0].next_check_number);
      await client.query("UPDATE bank_accounts SET next_check_number = next_check_number + 1 WHERE yard = $1", [account]);
    }
  }

  const total = Math.round((tickets.reduce((s, t) => s + parseFloat(t.total), 0) + freights.reduce((s, f) => s + parseFloat(f.cost), 0)) * 100) / 100;
  const { rows: remRows } = await client.query(
    `INSERT INTO remittances (payee, method, check_number, account, date, total, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [payee.trim(), method, finalCheckNumber, account, date, total, userId || null]
  );
  const remittance = remRows[0];

  const lines = [];
  for (const t of tickets) {
    const { rows: lineRows } = await client.query(
      "INSERT INTO remittance_lines (remittance_id, kind, ref_id, amount) VALUES ($1,'ticket',$2,$3) RETURNING *",
      [remittance.id, t.id, t.total]
    );
    lines.push(lineRows[0]);
    // Paying a Held ticket closes it in the same step (the cashier's "Pay" button).
    await client.query(
      `UPDATE tickets SET paid = true, remittance_id = $2, status = 'Closed',
         closed_at = COALESCE(closed_at, now()), closed_by = COALESCE(closed_by, $3)
       WHERE id = $1`,
      [t.id, remittance.id, userId || null]
    );
    await logAudit(client, {
      userId, action: "ticket.pay", entity: "ticket", entityId: t.id,
      details: { remittanceId: remittance.id, method, checkNumber: finalCheckNumber, amount: parseFloat(t.total), payee: payee.trim(), source },
    });
  }
  for (const f of freights) {
    const { rows: lineRows } = await client.query(
      "INSERT INTO remittance_lines (remittance_id, kind, ref_id, amount) VALUES ($1,'freight',$2,$3) RETURNING *",
      [remittance.id, f.id, f.cost]
    );
    lines.push(lineRows[0]);
    await client.query("UPDATE freight_tickets SET paid = true, remittance_id = $2 WHERE id = $1", [f.id, remittance.id]);
    await logAudit(client, {
      userId, action: "freight.pay", entity: "freight", entityId: f.id,
      details: { remittanceId: remittance.id, method, checkNumber: finalCheckNumber, amount: parseFloat(f.cost), payee: payee.trim() },
    });
    await logAudit(client, {
      userId, action: "ticket.freight_pay", entity: "ticket", entityId: f.ticket_id,
      details: { freightId: f.id, remittanceId: remittance.id, method, checkNumber: finalCheckNumber, amount: parseFloat(f.cost), payee: payee.trim() },
    });
  }
  await logAudit(client, {
    userId, action: "remittance.create", entity: "remittance", entityId: remittance.id,
    details: { payee: payee.trim(), method, checkNumber: finalCheckNumber, account, total, ticketIds, freightIds, source },
  });

  return { ...remittance, lines };
}

module.exports = { createRemittance, METHODS };
