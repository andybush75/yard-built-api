// Box charges (rent + mileage) — see src/boxCharges.js for the rules. The purchase screen reads a
// customer's pending charges here and applies / waives them as part of POST /tickets (boxCharges);
// Freight → Box Rent lists them all and lets the office waive, change or add one by hand.
const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission, userCan } = require("../middleware/auth");
const { logAudit } = require("../audit");
const svc = require("../boxCharges");
const motive = require("../motive");

const router = express.Router();
const canCharge = (req, res, next) => (userCan(req.user, "dispatchBoxes") || userCan(req.user, "manageBoxes")
  ? next() : res.status(403).json({ error: "Missing permission: dispatchBoxes" }));
const r2 = (n) => Math.round(n * 100) / 100;

async function withClient(fn) {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
const COLS = `c.*, u1.name AS applied_by_name, u2.name AS waived_by_name, 'J-' || j.job_no AS job_label, t.date AS ticket_date`;
const FROM = `FROM box_charges c LEFT JOIN users u1 ON u1.id = c.applied_by LEFT JOIN users u2 ON u2.id = c.waived_by
  LEFT JOIN box_jobs j ON j.id = c.job_id LEFT JOIN tickets t ON t.id = c.ticket_id`;
async function one(id) { const { rows } = await query(`SELECT ${COLS} ${FROM} WHERE c.id = $1`, [id]); return rows[0]; }

// What's waiting for this customer — the purchase screen calls this when a dealer is picked.
// Mileage is estimated right now from Motive (the truck is at the scale).
router.get("/pending", requireAuth, async (req, res) => {
  const { vendorId, name } = req.query;
  let n = name;
  if (vendorId && !n) { const { rows } = await query("SELECT name FROM vendors WHERE id = $1", [vendorId]); n = rows[0] && rows[0].name; }
  const list = await withClient((c) => svc.pendingFor(c, { vendorId, name: n }));
  const s = await withClient((c) => svc.settings(c));
  res.json({ charges: list, settings: s, motive: motive.configured() });
});

// Everything for the Box Rent screen: charges (open or recent history) and the boxes on the clock
// right now with the rent they'd owe if picked up today.
router.get("/", requireAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 400);
  const { rows } = await query(
    `SELECT ${COLS} ${FROM} WHERE c.status = 'pending' OR c.created_at > now() - ($1 || ' days')::interval ORDER BY c.created_at DESC LIMIT 2000`, [days]);
  const s = await withClient((c) => svc.settings(c));
  const { rows: boxes } = await query(
    `SELECT b.id, b.number, b.kind, b.size, b.home_yard, b.current_yard, b.customer_name, b.site, b.placed_at, b.vendor_id, v.box_rent_business
     FROM boxes b LEFT JOIN vendors v ON v.id = b.vendor_id
     WHERE b.status = 'customer' AND b.active = true AND b.placed_at IS NOT NULL ORDER BY b.placed_at`);
  const { rows: flags } = await query("SELECT lower(name) AS n, box_rent_business FROM vendors WHERE box_rent_business IS NOT NULL");
  const flagByName = new Map(flags.map((f) => [f.n, f.box_rent_business]));
  const now = new Date();
  const onClock = boxes.map((b) => {
    const set = b.box_rent_business !== null && b.box_rent_business !== undefined ? b.box_rent_business : flagByName.get(String(b.customer_name || "").toLowerCase());
    const business = set !== undefined && set !== null ? set : svc.guessBusiness(b.customer_name);
    const { days: d, amount } = svc.rentAmount(b.placed_at, now, s);
    return { ...b, days_on_site: d, rent_to_date: amount, business, business_set: set !== undefined && set !== null };
  });
  res.json({ charges: rows, onClock, settings: s, motive: motive.configured() });
});

// Change a pending charge (amount, or miles for mileage — which re-figures the amount), add a note.
router.patch("/:id", requireAuth, canCharge, async (req, res) => {
  const b = req.body || {};
  const ch = await one(req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  if (ch.status !== "pending") return res.status(400).json({ error: `This charge is ${ch.status}` });
  const s = await withClient((c) => svc.settings(c));
  let miles = ch.miles, source = ch.miles_source, calc = parseFloat(ch.calc_amount), amount = parseFloat(ch.amount);
  if (ch.kind === "mileage" && b.miles !== undefined && b.miles !== "" && b.miles !== null) {
    miles = Math.max(0, Math.round(parseFloat(b.miles) * 10) / 10); source = "manual"; calc = svc.mileageAmount(miles, s); amount = calc;
  }
  if (b.amount !== undefined && b.amount !== "" && b.amount !== null) {
    amount = r2(parseFloat(b.amount));
    if (isNaN(amount) || amount < 0) return res.status(400).json({ error: "Amount must be zero or more" });
  }
  await query("UPDATE box_charges SET miles=$2, miles_source=$3, calc_amount=$4, amount=$5, notes=COALESCE($6, notes), updated_at=now() WHERE id=$1",
    [ch.id, miles, source, calc, amount, b.notes === undefined ? null : String(b.notes)]);
  await logAudit({ query }, { userId: req.user.id, action: "boxcharge.edit", entity: "box_charge", entityId: ch.id, details: { miles: b.miles ?? null, amount: b.amount ?? null } });
  res.json(await one(ch.id));
});

router.post("/:id/waive", requireAuth, canCharge, async (req, res) => {
  const ch = await one(req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  if (ch.status !== "pending") return res.status(400).json({ error: `This charge is ${ch.status}` });
  const reason = String((req.body || {}).reason || "").trim() || "Waived";
  await query("UPDATE box_charges SET status='waived', waived_at=now(), waived_by=$2, waive_reason=$3, updated_at=now() WHERE id=$1", [ch.id, req.user.id, reason]);
  await logAudit({ query }, { userId: req.user.id, action: "boxcharge.waive", entity: "box_charge", entityId: ch.id, details: { reason, amount: ch.amount } });
  res.json(await one(ch.id));
});

router.post("/:id/unwaive", requireAuth, canCharge, async (req, res) => {
  const ch = await one(req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  if (ch.status !== "waived") return res.status(400).json({ error: `This charge is ${ch.status}` });
  await query("UPDATE box_charges SET status='pending', waived_at=NULL, waived_by=NULL, waive_reason=NULL, updated_at=now() WHERE id=$1", [ch.id]);
  await logAudit({ query }, { userId: req.user.id, action: "boxcharge.unwaive", entity: "box_charge", entityId: ch.id });
  res.json(await one(ch.id));
});

// A charge with no box move behind it — e.g. a haul that wasn't on the board. It waits for the
// customer's next ticket like any other.
router.post("/", requireAuth, canCharge, async (req, res) => {
  const b = req.body || {};
  if (!["rent", "mileage"].includes(b.kind)) return res.status(400).json({ error: "kind must be rent or mileage" });
  if (!String(b.customerName || "").trim()) return res.status(400).json({ error: "Enter the customer" });
  const s = await withClient((c) => svc.settings(c));
  let amount = b.amount !== undefined && b.amount !== "" && b.amount !== null ? r2(parseFloat(b.amount)) : null;
  const miles = b.kind === "mileage" && b.miles !== undefined && b.miles !== "" ? Math.max(0, parseFloat(b.miles)) : null;
  if (amount === null && miles !== null) amount = svc.mileageAmount(miles, s);
  if (amount === null || isNaN(amount) || amount < 0) return res.status(400).json({ error: "Enter an amount" + (b.kind === "mileage" ? " or the miles" : "") });
  let vendorId = b.vendorId || null;
  if (!vendorId) { const { rows } = await query("SELECT id FROM vendors WHERE lower(name) = lower($1) LIMIT 1", [String(b.customerName).trim()]); vendorId = rows[0] ? rows[0].id : null; }
  const { rows } = await query(
    `INSERT INTO box_charges (kind, status, yard, customer_name, vendor_id, box_number, truck, miles, miles_source, rate_per_mile, calc_amount, amount, notes)
     VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING id`,
    [b.kind, b.yard || req.user.home_yard || "SB", String(b.customerName).trim(), vendorId, b.boxNumber || null, b.truck || null,
     miles, miles !== null ? "manual" : null, b.kind === "mileage" ? s.mileRate : null, amount, String(b.notes || "").trim() || "Added by hand"]);
  await logAudit({ query }, { userId: req.user.id, action: "boxcharge.create", entity: "box_charge", entityId: rows[0].id, details: b });
  res.status(201).json(await one(rows[0].id));
});

// Mark a dealer a business (no box rent) or an individual. Pending rent for them follows the flag:
// business → waived; individual → rent that was waived only because of the business guess comes back.
router.post("/business", requireAuth, canCharge, async (req, res) => {
  const { vendorId, business } = req.body || {};
  if (!vendorId) return res.status(400).json({ error: "vendorId is required" });
  const val = business === null ? null : !!business;
  const { rows } = await query("UPDATE vendors SET box_rent_business = $2 WHERE id = $1 RETURNING id, name", [vendorId, val]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const name = rows[0].name;
  let changed = 0;
  if (val === true) {
    const r = await query(`UPDATE box_charges SET status='waived', business=true, waived_at=now(), waived_by=$3, waive_reason='Business customer — not charged', updated_at=now()
      WHERE kind='rent' AND status='pending' AND (vendor_id=$1 OR lower(customer_name)=lower($2))`, [vendorId, name, req.user.id]);
    changed = r.rowCount;
  } else if (val === false) {
    const r = await query(`UPDATE box_charges SET status='pending', business=false, waived_at=NULL, waived_by=NULL, waive_reason=NULL, updated_at=now()
      WHERE kind='rent' AND status='waived' AND ticket_id IS NULL AND business = true AND waived_by IS NULL AND (vendor_id=$1 OR lower(customer_name)=lower($2))`, [vendorId, name]);
    changed = r.rowCount;
  }
  await logAudit({ query }, { userId: req.user.id, action: "vendor.box_rent_business", entity: "vendor", entityId: vendorId, details: { business: val, chargesChanged: changed } });
  res.json({ vendorId, business: val, chargesChanged: changed });
});

// Is Motive connected, and which trucks does it see (to check the numbers match the drivers' Truck #).
router.get("/motive", requireAuth, async (req, res) => {
  if (!motive.configured()) return res.json({ configured: false, vehicles: [] });
  try { res.json({ configured: true, vehicles: await motive.listVehicles(req.query.refresh === "1") }); }
  catch (e) { res.json({ configured: true, error: e.message, vehicles: [] }); }
});

module.exports = router;
