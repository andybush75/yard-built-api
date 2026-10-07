const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
const TYPES = ["End dump", "Gondola", "Flatbed", "Van", "Railcar", "Other"];
const SELECT = "SELECT t.*, c.name AS carrier_name FROM trailers t LEFT JOIN carriers c ON c.id = t.carrier_id";

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(`${SELECT} ORDER BY t.active DESC, t.yard, t.number`);
  res.json(rows);
});

async function validate(body, partial) {
  const { number, yard, type, carrierId, targetTonsPerWeek } = body;
  if (!partial && (!number || !number.trim())) return "number is required";
  if (!partial && !yard) return "yard is required";
  if (type !== undefined && !TYPES.includes(type)) return `type must be one of ${TYPES.join(", ")}`;
  if (targetTonsPerWeek !== undefined && targetTonsPerWeek !== null && !(Number.isInteger(targetTonsPerWeek) && targetTonsPerWeek >= 0)) return "targetTonsPerWeek must be a whole number";
  if (carrierId) {
    const { rows } = await query("SELECT id FROM carriers WHERE id = $1", [carrierId]);
    if (!rows.length) return "carrierId does not match any carrier";
  }
  return null;
}

router.post("/", requireAuth, async (req, res) => {
  const body = req.body || {};
  const err = await validate(body, false);
  if (err) return res.status(400).json({ error: err });
  try {
    const { rows } = await query(
      `INSERT INTO trailers (number, yard, type, carrier_id, owned, target_tons_per_week, notes)
       VALUES ($1,$2,COALESCE($3,'Gondola'),$4,COALESCE($5,true),$6,$7) RETURNING id`,
      [body.number.trim(), body.yard, body.type, body.carrierId || null, body.owned, body.targetTonsPerWeek ?? null, body.notes || null]
    );
    const { rows: out } = await query(`${SELECT} WHERE t.id = $1`, [rows[0].id]);
    res.status(201).json(out[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: `Trailer ${body.number} already exists` });
    throw e;
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  const body = req.body || {};
  const err = await validate(body, true);
  if (err) return res.status(400).json({ error: err });
  // carrierId: "" clears the current carrier (back to Langer / unassigned); undefined leaves it alone.
  const clearCarrier = body.carrierId === "" || body.carrierId === null;
  const clearTarget = body.targetTonsPerWeek === null;
  const { rows } = await query(
    `UPDATE trailers SET number = COALESCE($2, number), yard = COALESCE($3, yard), type = COALESCE($4, type),
       carrier_id = CASE WHEN $5 THEN NULL ELSE COALESCE($6, carrier_id) END,
       owned = COALESCE($7, owned), active = COALESCE($8, active),
       target_tons_per_week = CASE WHEN $9 THEN NULL ELSE COALESCE($10, target_tons_per_week) END,
       notes = COALESCE($11, notes)
     WHERE id = $1 RETURNING id`,
    [req.params.id, body.number ? body.number.trim() : null, body.yard ?? null, body.type ?? null, clearCarrier, body.carrierId || null,
     body.owned ?? null, body.active ?? null, clearTarget, body.targetTonsPerWeek ?? null, body.notes ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const { rows: out } = await query(`${SELECT} WHERE t.id = $1`, [req.params.id]);
  res.json(out[0]);
});

// The utilization report: for each trailer, loads and tons per Sun–Sat week, outbound (sells) and
// inbound (buys), for the last N weeks ending with the current partial week; days since the last
// load each way; and the tons target to measure against. Weeks with any ticket on the trailer are
// computed from tickets; otherwise the week comes from the imported TMS history, so the tracker
// shows the full picture across the cutover.
router.get("/utilization", requireAuth, async (req, res) => {
  const weeksN = Math.min(Math.max(parseInt(req.query.weeks, 10) || 13, 2), 52);
  const asOf = req.query.asOf ? new Date(req.query.asOf + "T00:00:00Z") : new Date();
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const thisSunday = new Date(asOfDay); thisSunday.setUTCDate(asOfDay.getUTCDate() - asOfDay.getUTCDay());
  const weeks = [];
  for (let i = weeksN - 1; i >= 0; i--) {
    const s = new Date(thisSunday); s.setUTCDate(thisSunday.getUTCDate() - 7 * i);
    const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
    weeks.push({ start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) });
  }
  const firstStart = weeks[0].start;

  const [settings, trailers, computed, history, lastLoads] = await Promise.all([
    query("SELECT key, value FROM app_settings WHERE key LIKE 'trailer_%'"),
    query(`${SELECT} WHERE t.active = true ORDER BY t.yard, t.number`),
    // one load = one shipment (or one lone ticket) on one trailer on one day
    query(
      `SELECT trailer_id, type,
              (date - ((EXTRACT(DOW FROM date))::int))::date AS week_start,
              COUNT(DISTINCT COALESCE(shipment_id, id)) AS loads,
              SUM(net_weight) / 2000.0 AS tons
       FROM tickets
       WHERE trailer_id IS NOT NULL AND status <> 'Voided' AND date >= $1 AND date <= $2
       GROUP BY trailer_id, type, week_start`,
      [firstStart, asOfDay.toISOString().slice(0, 10)]
    ),
    query("SELECT * FROM trailer_week_history WHERE week_start >= $1", [firstStart]),
    query(
      `SELECT trailer_id, type, MAX(date) AS last_date FROM tickets
       WHERE trailer_id IS NOT NULL AND status <> 'Voided' GROUP BY trailer_id, type`
    ),
  ]);
  const cfg = {};
  settings.rows.forEach((r) => { cfg[r.key] = r.value; });
  const targets = cfg.trailer_tons_target_by_type || {};
  const defaultTarget = cfg.trailer_default_tons_target || 100;
  const loadsGoal = cfg.trailer_loads_goal_per_week || 5;

  const idx = new Map(weeks.map((w, i) => [w.start, i]));
  const empty = () => weeks.map(() => 0);
  const out = trailers.rows.map((t) => ({
    id: t.id, number: t.number, yard: t.yard, type: t.type, carrierId: t.carrier_id, carrierName: t.carrier_name,
    owned: t.owned, target: t.target_tons_per_week ?? targets[t.type] ?? defaultTarget,
    outLoads: empty(), outTons: empty(), inLoads: empty(), inTons: empty(), computedWeeks: new Set(),
    daysSinceOut: null, daysSinceIn: null,
  }));
  const byId = new Map(out.map((t) => [t.id, t]));
  computed.rows.forEach((r) => {
    const t = byId.get(r.trailer_id); const i = idx.get(String(r.week_start).slice(0, 10));
    if (!t || i === undefined) return;
    t.computedWeeks.add(i);
    if (r.type === "sell") { t.outLoads[i] = parseFloat(r.loads); t.outTons[i] = Math.round(parseFloat(r.tons) * 10) / 10; }
    else { t.inLoads[i] = parseFloat(r.loads); t.inTons[i] = Math.round(parseFloat(r.tons) * 10) / 10; }
  });
  history.rows.forEach((r) => {
    const t = byId.get(r.trailer_id); const i = idx.get(String(r.week_start).slice(0, 10));
    if (!t || i === undefined || t.computedWeeks.has(i)) return;
    t.outLoads[i] = parseFloat(r.out_loads); t.outTons[i] = parseFloat(r.out_tons); t.inLoads[i] = parseFloat(r.in_loads); t.inTons[i] = parseFloat(r.in_tons);
  });
  const dayDiff = (d) => Math.round((asOfDay - new Date(String(d).slice(0, 10) + "T00:00:00Z")) / 86400000);
  lastLoads.rows.forEach((r) => {
    const t = byId.get(r.trailer_id); if (!t) return;
    if (r.type === "sell") t.daysSinceOut = dayDiff(r.last_date); else t.daysSinceIn = dayDiff(r.last_date);
  });
  // No ticket on record: fall back to the most recent imported week that had a load.
  out.forEach((t) => {
    if (t.daysSinceOut === null) { const k = t.outLoads.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0).pop(); if (k !== undefined) t.daysSinceOut = dayDiff(weeks[k].end) + 0; }
    if (t.daysSinceIn === null) { const k = t.inLoads.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0).pop(); if (k !== undefined) t.daysSinceIn = dayDiff(weeks[k].end) + 0; }
    delete t.computedWeeks;
  });
  res.json({ asOf: asOfDay.toISOString().slice(0, 10), weeks, targets, defaultTarget, loadsGoal, trailers: out });
});

// One-time (or repeatable) import of weekly history, e.g. from the old TMS sheet.
// Body: { rows: [{ number, yard, type, carrierName?, owned?, weekStart, outLoads, outTons, inLoads, inTons }] }
// Unknown trailer numbers are created. Existing weeks are overwritten.
router.post("/import-history", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const rows = (req.body || {}).rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows must be a non-empty list" });
  let created = 0, weeksWritten = 0;
  for (const r of rows) {
    if (!r.number || !r.weekStart) continue;
    let { rows: tr } = await query("SELECT id FROM trailers WHERE number = $1", [String(r.number)]);
    if (!tr.length) {
      let carrierId = null;
      if (r.carrierName) {
        const { rows: c } = await query("SELECT id FROM carriers WHERE lower(name) = lower($1)", [r.carrierName]);
        if (c.length) carrierId = c[0].id;
        else { const { rows: nc } = await query("INSERT INTO carriers (name, type) VALUES ($1, 'common') RETURNING id", [r.carrierName]); carrierId = nc[0].id; }
      }
      const ins = await query(
        "INSERT INTO trailers (number, yard, type, carrier_id, owned) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [String(r.number), r.yard || "SB", TYPES.includes(r.type) ? r.type : "Other", carrierId, r.owned !== false]
      );
      tr = ins.rows; created++;
    }
    await query(
      `INSERT INTO trailer_week_history (trailer_id, week_start, out_loads, out_tons, in_loads, in_tons, source)
       VALUES ($1,$2,$3,$4,$5,$6,'tms_sheet')
       ON CONFLICT (trailer_id, week_start) DO UPDATE SET out_loads = EXCLUDED.out_loads, out_tons = EXCLUDED.out_tons, in_loads = EXCLUDED.in_loads, in_tons = EXCLUDED.in_tons`,
      [tr[0].id, r.weekStart, r.outLoads || 0, r.outTons || 0, r.inLoads || 0, r.inTons || 0]
    );
    weeksWritten++;
  }
  res.json({ trailersCreated: created, weeksWritten });
});

module.exports = router;
