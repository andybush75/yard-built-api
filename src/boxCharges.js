// Box charges: box rent and truck mileage that come off the customer's buy ticket.
//
// Rent — figured the moment a box leaves a customer (a pick-up, or the full box in a swap):
//   days on site = drop → pick-up; the first `boxRentFreeDays` are free; after that it's
//   `boxRentWeekly` per week, prorated by the day (day 14 = 1 week = $125, day 10 = 3 days).
//   Business customers aren't charged: their rent is recorded but waived automatically.
// Mileage — one per pick-up / swap job done on a truck: Motive odometer from when the driver
//   started the job to when the truck is back across the scale, times `boxMileageRate`, less
//   `boxMileageFreeMiles`, with a `boxMileageMinimum`. Off until a rate is set.
//
// Both sit as "pending" for that customer. The purchase screen shows them already applied; the
// scale operator can change the amount (or the miles) or waive any of them. Applied charges go on
// tickets.deductions, which lowers what the ticket pays out — never the material value.
const motive = require("./motive");

const r2 = (n) => Math.round(n * 100) / 100;
const DAY = 86400000;

async function settings(client) {
  const { rows } = await client.query("SELECT key, value FROM app_settings WHERE key LIKE 'box%'");
  const s = {}; rows.forEach((r) => { s[r.key] = r.value; });
  const num = (v, d) => (v === null || v === undefined || v === "" || isNaN(parseFloat(v)) ? d : parseFloat(v));
  return {
    weekly: num(s.boxRentWeekly, 125), freeDays: num(s.boxRentFreeDays, 7),
    mileRate: num(s.boxMileageRate, null), freeMiles: num(s.boxMileageFreeMiles, 0), minimum: num(s.boxMileageMinimum, 0),
  };
}

// Same idea as the old box-rent tracker: if nobody has said, a company-sounding name is a business.
const BUSINESS_WORDS = /\b(llc|l\.l\.c|inc|corp|co\b|company|ltd|ranch|farms?|feed|feedlot|implement|equipment|auto|motors?|salvage|trucking|transport|construction|const\.?|repair|diesel|welding|fab|fabrication|machine|electric|plumbing|supply|services?|industries|industrial|manufacturing|mfg|parts|tire|body shop|shop|sales|co-?op|cooperative|city of|county|school|church|hospital|dept|department|rail|energy|oil|gas|ag\b|agri)\b/i;
function guessBusiness(name) { return BUSINESS_WORDS.test(String(name || "")); }

async function isBusiness(client, vendorId, name) {
  if (vendorId) {
    const { rows } = await client.query("SELECT box_rent_business FROM vendors WHERE id = $1", [vendorId]);
    if (rows.length && rows[0].box_rent_business !== null) return { business: rows[0].box_rent_business, set: true };
  } else if (name) {
    const { rows } = await client.query("SELECT box_rent_business FROM vendors WHERE lower(name) = lower($1) AND box_rent_business IS NOT NULL LIMIT 1", [name]);
    if (rows.length) return { business: rows[0].box_rent_business, set: true };
  }
  return { business: guessBusiness(name), set: false };
}

function rentAmount(placedAt, endAt, s) {
  const days = Math.max(0, Math.floor((new Date(endAt) - new Date(placedAt)) / DAY));
  const billable = Math.max(0, days - s.freeDays);
  return { days, billable, amount: r2((billable * s.weekly) / 7) };
}

// rate: the customer's own rate if they have one, else the company rate (s.mileRate).
function mileageAmount(miles, s, rate) {
  const r = rate === undefined ? s.mileRate : rate;
  if (r === null || r === undefined || miles === null || miles === undefined) return 0;
  const m = Math.max(0, parseFloat(miles) - s.freeMiles);
  if (m <= 0 || parseFloat(r) <= 0) return 0;
  return r2(Math.max(m * parseFloat(r), s.minimum));
}

// The rate per mile for a customer: their own (set on the dealer) or the company rate. null = off.
async function mileRateFor(client, vendorId, name, s) {
  const { rows } = vendorId
    ? await client.query("SELECT box_mileage_rate FROM vendors WHERE id = $1", [vendorId])
    : name ? await client.query("SELECT box_mileage_rate FROM vendors WHERE lower(name) = lower($1) AND box_mileage_rate IS NOT NULL LIMIT 1", [name]) : { rows: [] };
  if (rows.length && rows[0].box_mileage_rate !== null) return { rate: parseFloat(rows[0].box_mileage_rate), own: true };
  return { rate: s.mileRate, own: false };
}
const chargeRate = (ch, s) => (ch.rate_per_mile !== null && ch.rate_per_mile !== undefined ? parseFloat(ch.rate_per_mile) : s.mileRate);

// Called from POST /boxes/moves inside its transaction, for a box that was at a customer and just
// left (pick-up, or the full box in a swap). `prev` is the box as it was before the move.
async function rentOnPickup(client, { prev, box, moveId, occurredAt, yard }) {
  if (!prev || prev.status !== "customer" || !prev.placed_at || !prev.customer_name) return null;
  const s = await settings(client);
  const { days, amount } = rentAmount(prev.placed_at, occurredAt, s);
  if (amount <= 0) return null;
  const biz = await isBusiness(client, prev.vendor_id, prev.customer_name);
  const { rows } = await client.query(
    `INSERT INTO box_charges (kind, status, yard, customer_name, vendor_id, box_id, box_number, move_id, placed_at, picked_up_at, days_on_site,
       free_days, weekly_rate, calc_amount, amount, business, waived_at, waive_reason)
     VALUES ('rent',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16)
     ON CONFLICT DO NOTHING RETURNING *`,
    [biz.business ? "waived" : "pending", yard, prev.customer_name, prev.vendor_id || null, box.id, box.number, moveId, prev.placed_at, occurredAt, days,
     s.freeDays, s.weekly, amount, biz.business, biz.business ? new Date() : null,
     biz.business ? (biz.set ? "Business customer — not charged" : "Looks like a business — not charged (set it on the dealer if that's wrong)") : null]);
  return rows[0] || null;
}

// Called when a pick-up / swap job is finished by a box move: one mileage charge for that trip.
async function mileageForJob(client, { job, moveId, truck, yard, customerName, vendorId }) {
  const s = await settings(client);
  const { rate } = await mileRateFor(client, vendorId, customerName, s);
  if (rate === null || rate <= 0) return null;   // no company rate and none for this customer, or set to 0 = never charge
  const t = String(truck || job.truck || "").trim();
  const { rows } = await client.query(
    `INSERT INTO box_charges (kind, status, yard, customer_name, vendor_id, job_id, move_id, truck, trip_start, rate_per_mile, calc_amount, amount, notes)
     VALUES ('mileage','pending',$1,$2,$3,$4,$5,$6,$7,$8,0,0,$9) ON CONFLICT DO NOTHING RETURNING *`,
    [yard, customerName, vendorId || null, job.id, moveId, t || null, job.started_at || null, rate,
     !t ? "No truck # on this job — enter the miles by hand." : !job.started_at ? "The driver never pressed Start — enter the miles by hand." : null]);
  return rows[0] || null;
}

// Fill in a pending mileage charge's miles from Motive, as of `endAt` (default: now, i.e. the truck is
// at the scale). Never overwrites miles someone typed in. Returns the updated row.
async function estimateMileage(client, ch, endAt) {
  if (ch.kind !== "mileage" || ch.status !== "pending" || ch.miles_source === "manual") return ch;
  const s = await settings(client);
  const end = endAt ? new Date(endAt) : new Date();
  let miles = null, odo = null, note = ch.notes;
  if (ch.truck && ch.trip_start && motive.configured()) {
    try {
      const trip = await motive.tripMiles(ch.truck, ch.trip_start, end);
      miles = trip.miles; odo = trip; note = null;
    } catch (e) { note = "Motive: " + e.message + " — enter the miles by hand."; }
  } else if (ch.truck && ch.trip_start && !motive.configured()) {
    note = "Motive isn't connected yet — enter the miles by hand.";
  }
  const amount = mileageAmount(miles, s, chargeRate(ch, s));
  const { rows } = await client.query(
    `UPDATE box_charges SET miles=$2, miles_source=$3, odometer=$4, trip_end=$5, calc_amount=$6, amount=$6, notes=$7, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [ch.id, miles, miles === null ? null : "motive", odo ? JSON.stringify(odo) : null, end, amount, note]);
  return rows[0];
}

async function pendingFor(client, { vendorId, name }) {
  const vals = [], or = [];
  if (vendorId) { vals.push(vendorId); or.push(`vendor_id = $${vals.length}`); }
  if (name) { vals.push(name); or.push(`lower(customer_name) = lower($${vals.length})`); }
  if (!or.length) return [];
  const { rows } = await client.query(
    `SELECT * FROM box_charges WHERE status IN ('pending','waived') AND ticket_id IS NULL AND (${or.join(" OR ")})
       AND (status = 'pending' OR waived_at > now() - interval '30 days')
     ORDER BY created_at`, vals);
  const out = [];
  for (const ch of rows) out.push(ch.kind === "mileage" && ch.status === "pending" ? await estimateMileage(client, ch) : ch);
  return out;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// Apply / waive charges as part of posting a buy ticket. items: [{ id, action: "apply"|"waive",
// amount?, miles?, reason? }]. Returns the total deducted. Runs inside the caller's transaction.
async function applyToTicket(client, ticket, items, userId) {
  if (!Array.isArray(items) || !items.length) return 0;
  if (ticket.type !== "buy") throw fail(400, "Box charges only come off buy tickets");
  const s = await settings(client);
  let total = 0;
  for (const it of items) {
    const { rows } = await client.query("SELECT * FROM box_charges WHERE id = $1 FOR UPDATE", [it.id]);
    const ch = rows[0];
    if (!ch) throw fail(400, "A box charge on this ticket no longer exists — reload and try again");
    if (ch.ticket_id || ch.status === "applied") throw fail(409, `That ${ch.kind} charge was already taken on ticket ${ch.ticket_id}`);
    if (ch.status === "void") throw fail(409, `That ${ch.kind} charge was voided`);
    if (it.action === "waive") {
      await client.query(`UPDATE box_charges SET status='waived', waived_at=now(), waived_by=$2, waive_reason=$3, updated_at=now() WHERE id=$1`,
        [ch.id, userId, String(it.reason || "").trim() || "Waived at the scale"]);
      continue;
    }
    if (it.action !== "apply") continue;
    let miles = ch.miles, source = ch.miles_source, calc = parseFloat(ch.calc_amount);
    if (ch.kind === "mileage" && it.miles !== undefined && it.miles !== null && it.miles !== "" && parseFloat(it.miles) !== parseFloat(ch.miles)) {
      miles = Math.max(0, Math.round(parseFloat(it.miles) * 10) / 10); source = "manual"; calc = mileageAmount(miles, s, chargeRate(ch, s));
    }
    let amount = it.amount !== undefined && it.amount !== null && it.amount !== "" ? r2(parseFloat(it.amount)) : calc;
    if (isNaN(amount) || amount < 0) throw fail(400, "A box charge amount must be zero or more");
    total = r2(total + amount);
    await client.query(
      `UPDATE box_charges SET status='applied', ticket_id=$2, applied_at=now(), applied_by=$3, amount=$4, calc_amount=$5, miles=$6, miles_source=$7,
         trip_end=COALESCE(trip_end, now()), waived_at=NULL, waived_by=NULL, waive_reason=NULL, updated_at=now() WHERE id=$1`,
      [ch.id, ticket.id, userId, amount, calc, miles, source]);
  }
  if (total > 0) {
    const max = r2(parseFloat(ticket.total) - parseFloat(ticket.deductions || 0));
    if (total > max) throw fail(400, `Box charges ($${total.toFixed(2)}) are more than this ticket pays ($${max.toFixed(2)}) — lower or waive some, or put them on a bigger line`);
    await client.query("UPDATE tickets SET deductions = deductions + $2 WHERE id = $1", [ticket.id, total]);
  }
  return total;
}

// A voided ticket gives its box charges back: they go pending again for the next ticket.
async function releaseFromTicket(client, ticketId) {
  await client.query(
    `UPDATE box_charges SET status='pending', ticket_id=NULL, applied_at=NULL, applied_by=NULL, updated_at=now() WHERE ticket_id = $1 AND status = 'applied'`, [ticketId]);
}

module.exports = { settings, guessBusiness, isBusiness, rentAmount, mileageAmount, mileRateFor, chargeRate, rentOnPickup, mileageForJob, estimateMileage, pendingFor, applyToTicket, releaseFromTicket };
