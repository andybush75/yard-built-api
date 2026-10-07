// Yard transfers. Each yard is its own profit center, so moving material from one yard to another
// is a real sale, not a silent inventory move (business rule):
//   - a SELL at the sending yard at the transfer price (master price + margin) — the sending yard
//     books the margin between its own cost and that price, exactly like an outside sale;
//   - a BUY at the receiving yard at the same price — its new cost basis;
// both tagged kind = 'transfer' so KBI, mill reconciliation and the Volumes "Purchased/Sold"
// columns leave them out. The buy leg is marked paid: no cash moves between yard bank accounts.
const { logAudit } = require("./audit");

const BASES = ["pct", "perlb", "perton"];
function fail(status, message) { const e = new Error(message); e.status = status; return e; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function nowTimeLabel() { return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

async function settings(client) {
  const { rows } = await client.query("SELECT key, value FROM app_settings WHERE key IN ('yard_price_multipliers','transfer_default_margin_pct')");
  const out = {}; rows.forEach((r) => { out[r.key] = r.value; });
  return out;
}

async function transferPrice(client, commodity, fromYard, basis, value) {
  const { rows } = await client.query("SELECT master_price FROM commodities WHERE code = $1", [commodity]);
  if (!rows.length) throw fail(400, "commodity does not match any commodity");
  const cfg = await settings(client);
  const mult = (cfg.yard_price_multipliers && cfg.yard_price_multipliers[fromYard]) || 1;
  const master = r3(parseFloat(rows[0].master_price) * mult);
  if (basis === "perlb") return r3(master + value);
  if (basis === "perton") return r3(master + value / 2000);
  return r3(master * (1 + value / 100));
}

async function lockBalance(client, yard, commodity) {
  const { rows } = await client.query("SELECT * FROM inventory_balances WHERE yard = $1 AND commodity = $2 FOR UPDATE", [yard, commodity]);
  if (rows.length) return rows[0];
  const ins = await client.query("INSERT INTO inventory_balances (yard, commodity, qty, avg_cost) VALUES ($1,$2,0,0) RETURNING *", [yard, commodity]);
  return ins.rows[0];
}

async function ledger(client, yard, commodity, type, qtyChange, unitPrice, balanceQty, avgCost, ref, date) {
  await client.query(
    `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date, time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [yard, commodity, type, qtyChange, unitPrice, balanceQty, avgCost, r2(balanceQty * avgCost), ref, date, nowTimeLabel()]
  );
}

async function createTransfer(client, { fromYard, toYard, commodity, netWeight, marginBasis = "pct", marginValue, notes, date, trailerId, userId, yardNames }) {
  if (!fromYard || !toYard || !commodity) throw fail(400, "fromYard, toYard and commodity are required");
  if (fromYard === toYard) throw fail(400, "Choose a different destination yard");
  if (!BASES.includes(marginBasis)) throw fail(400, "marginBasis must be pct, perlb or perton");
  const qty = parseFloat(netWeight);
  if (!(qty > 0)) throw fail(400, "netWeight must be greater than zero");
  const margin = parseFloat(marginValue);
  if (isNaN(margin) || margin < 0) throw fail(400, "marginValue must be zero or more");
  if (trailerId) {
    const { rows } = await client.query("SELECT id FROM trailers WHERE id = $1", [trailerId]);
    if (!rows.length) throw fail(400, "trailerId does not match any trailer");
  }
  const day = date || todayIso();
  const price = await transferPrice(client, commodity, fromYard, marginBasis, margin);
  const total = r2(qty * price);

  // Sending yard: lock first (yards locked in a fixed order to avoid deadlocks between two transfers).
  const [first, second] = [fromYard, toYard].sort();
  const balances = {};
  balances[first] = await lockBalance(client, first, commodity);
  balances[second] = await lockBalance(client, second, commodity);
  const from = balances[fromYard], to = balances[toYard];
  const fromQty = parseFloat(from.qty), fromAvg = parseFloat(from.avg_cost);
  if (qty > fromQty + 0.0005) throw fail(409, `Only ${fromQty} on hand at ${fromYard} — can't transfer ${qty}`);

  const { rows: s } = await client.query("SELECT nextval('ticket_sell_seq') AS n");
  const { rows: b } = await client.query("SELECT nextval('ticket_buy_seq') AS n");
  const { rows: x } = await client.query("SELECT nextval('yard_transfer_seq') AS n");
  const sellId = `S-${s[0].n}`, buyId = `B-${b[0].n}`, xferId = `YT-${x[0].n}`;
  const nameOf = (y) => (yardNames && yardNames[y]) || y;

  // Sell leg at the sending yard — margin = (price − that yard's average cost) × qty.
  const fromNewQty = fromQty - qty;
  await client.query("UPDATE inventory_balances SET qty = $3, updated_at = now() WHERE yard = $1 AND commodity = $2", [fromYard, commodity, fromNewQty]);
  await client.query(
    `INSERT INTO tickets (id, type, date, yard, party_name, commodity, net_weight, price, total, payment, status, paid, cogs_per_lb, kind, created_by, closed_at, closed_by, trailer_id)
     VALUES ($1,'sell',$2,$3,$4,$5,$6,$7,$8,'Internal Transfer','Closed',false,$9,'transfer',$10,now(),$10,$11)`,
    [sellId, day, fromYard, `Yard Transfer → ${nameOf(toYard)}`, commodity, qty, price, total, fromAvg, userId || null, trailerId || null]
  );
  await ledger(client, fromYard, commodity, "Transfer Out", -qty, null, fromNewQty, fromAvg, sellId, day);

  // Buy leg at the receiving yard — new cost basis blends in at the transfer price.
  const toQty = parseFloat(to.qty), toAvg = parseFloat(to.avg_cost);
  const toNewQty = toQty + qty;
  const toNewAvg = toNewQty > 0 ? (toQty * toAvg + qty * price) / toNewQty : price;
  await client.query("UPDATE inventory_balances SET qty = $3, avg_cost = $4, updated_at = now() WHERE yard = $1 AND commodity = $2", [toYard, commodity, toNewQty, toNewAvg]);
  await client.query(
    `INSERT INTO tickets (id, type, date, yard, party_name, commodity, net_weight, price, total, payment, status, paid, kind, created_by, closed_at, closed_by, trailer_id)
     VALUES ($1,'buy',$2,$3,$4,$5,$6,$7,$8,'Internal Transfer','Closed',true,'transfer',$9,now(),$9,$10)`,
    [buyId, day, toYard, `Yard Transfer ← ${nameOf(fromYard)}`, commodity, qty, price, total, userId || null, trailerId || null]
  );
  await ledger(client, toYard, commodity, "Transfer In", qty, price, toNewQty, toNewAvg, buyId, day);

  await client.query("UPDATE tickets SET transfer_id = $2, linked_ticket_id = $3 WHERE id = $1", [sellId, xferId, buyId]);
  await client.query("UPDATE tickets SET transfer_id = $2, linked_ticket_id = $3 WHERE id = $1", [buyId, xferId, sellId]);

  const marginDollars = r2((price - fromAvg) * qty);
  const { rows: xf } = await client.query(
    `INSERT INTO yard_transfers (id, date, from_yard, to_yard, commodity, net_weight, margin_basis, margin_value, price, total, cogs_per_lb, margin_dollars, notes, sell_ticket_id, buy_ticket_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [xferId, day, fromYard, toYard, commodity, qty, marginBasis, margin, price, total, fromAvg, marginDollars, notes || null, sellId, buyId, userId || null]
  );
  const details = { transferId: xferId, fromYard, toYard, commodity, netWeight: qty, price, total, marginBasis, marginValue: margin, marginDollars };
  await logAudit(client, { userId, action: "ticket.create", entity: "ticket", entityId: sellId, details: { type: "sell", yard: fromYard, party: `Yard Transfer → ${nameOf(toYard)}`, commodity, netWeight: qty, price, total, status: "Closed", transfer: xferId } });
  await logAudit(client, { userId, action: "ticket.create", entity: "ticket", entityId: buyId, details: { type: "buy", yard: toYard, party: `Yard Transfer ← ${nameOf(fromYard)}`, commodity, netWeight: qty, price, total, status: "Closed", transfer: xferId } });
  await logAudit(client, { userId, action: "transfer.create", entity: "transfer", entityId: xferId, details });
  return xf[0];
}

// Voiding a transfer voids both legs and puts the material back where it was. Not allowed once
// reconciled (both yards have signed off) — reconcile is the settlement checkmark.
async function voidTransfer(client, { id, reason, userId }) {
  const { rows } = await client.query("SELECT * FROM yard_transfers WHERE id = $1 FOR UPDATE", [id]);
  if (!rows.length) throw fail(404, "Not found");
  const x = rows[0];
  if (x.status === "Voided") throw fail(409, "Transfer is already voided");
  if (x.status === "Reconciled") throw fail(409, "Transfer has been reconciled — it can't be voided");
  const qty = parseFloat(x.net_weight);
  const [first, second] = [x.from_yard, x.to_yard].sort();
  const balances = {};
  balances[first] = await lockBalance(client, first, x.commodity);
  balances[second] = await lockBalance(client, second, x.commodity);
  const from = balances[x.from_yard], to = balances[x.to_yard];
  const day = todayIso();
  const fromNewQty = parseFloat(from.qty) + qty;
  await client.query("UPDATE inventory_balances SET qty = $3, updated_at = now() WHERE yard = $1 AND commodity = $2", [x.from_yard, x.commodity, fromNewQty]);
  await ledger(client, x.from_yard, x.commodity, "Void", qty, null, fromNewQty, parseFloat(from.avg_cost), x.sell_ticket_id, day);
  const toNewQty = parseFloat(to.qty) - qty;
  await client.query("UPDATE inventory_balances SET qty = $3, updated_at = now() WHERE yard = $1 AND commodity = $2", [x.to_yard, x.commodity, toNewQty]);
  await ledger(client, x.to_yard, x.commodity, "Void", -qty, null, toNewQty, parseFloat(to.avg_cost), x.buy_ticket_id, day);
  await client.query("UPDATE tickets SET status = 'Voided', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = ANY($1::text[])", [[x.sell_ticket_id, x.buy_ticket_id], userId || null, reason]);
  const { rows: out } = await client.query("UPDATE yard_transfers SET status = 'Voided', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 RETURNING *", [id, userId || null, reason]);
  for (const t of [x.sell_ticket_id, x.buy_ticket_id]) await logAudit(client, { userId, action: "ticket.void", entity: "ticket", entityId: t, details: { reason, transfer: id } });
  await logAudit(client, { userId, action: "transfer.void", entity: "transfer", entityId: id, details: { reason } });
  return out[0];
}

module.exports = { createTransfer, voidTransfer, transferPrice, BASES };
