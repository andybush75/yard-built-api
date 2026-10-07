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

async function createRemittance(client, { payee, method, checkNumber, account, date, ticketIds, userId, source }) {
  if (!METHODS.includes(method)) throw fail(400, "method must be Check or ACH");
  if (!payee || !payee.trim()) throw fail(400, "payee is required");
  if (!account) throw fail(400, "account (the yard whose bank account pays) is required");
  if (!date) throw fail(400, "date is required");
  if (!Array.isArray(ticketIds) || !ticketIds.length) throw fail(400, "ticketIds must be a non-empty list");

  // Lock the tickets so two people can't pay the same one at the same moment.
  const { rows: tickets } = await client.query("SELECT * FROM tickets WHERE id = ANY($1::text[]) FOR UPDATE", [ticketIds]);
  if (tickets.length !== ticketIds.length) throw fail(409, "One or more tickets were not found");
  for (const t of tickets) {
    if (t.type !== "buy") throw fail(400, `${t.id} is a sell ticket — only buy tickets are paid by remittance`);
    if (t.status === "Voided") throw fail(409, `${t.id} is voided`);
    if (t.paid) throw fail(409, `${t.id} is already paid`);
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

  const total = Math.round(tickets.reduce((s, t) => s + parseFloat(t.total), 0) * 100) / 100;
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
  await logAudit(client, {
    userId, action: "remittance.create", entity: "remittance", entityId: remittance.id,
    details: { payee: payee.trim(), method, checkNumber: finalCheckNumber, account, total, ticketIds, source },
  });

  return { ...remittance, lines };
}

module.exports = { createRemittance, METHODS };
