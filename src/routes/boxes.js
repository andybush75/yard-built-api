// Box Dispatch: the live box (container) list and the log of every drop / pick-up / swap.
// Drivers post moves from the phone page (/driver); the office sees and fixes them in Freight → Boxes.
const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission, userCan } = require("../middleware/auth");
const { logAudit } = require("../audit");

const router = express.Router();
const KINDS = ["Roll-off", "Lugger", "Hopper", "Tote", "Tire box", "Other"];
const STATUSES = ["yard", "customer", "repair", "missing", "retired"];
const ACTIONS = ["drop", "pickup", "swap", "yard_move", "status", "correction"];
const YARD_CODES = ["SB", "HAYS", "COLBY", "RC"];

// "M05", "m 5", "M-5" → "M-5";  "30-11", "30 11", "30/11" → "30-11";  "SD04" → "SD-4".
// Drivers type box numbers however they're painted; this lets them all find the same box.
function boxKey(s) {
  const toks = String(s || "").toUpperCase().match(/[A-Z]+|\d+/g) || [];
  return toks.map((t) => (/^\d+$/.test(t) ? String(parseInt(t, 10)) : t)).join("-");
}

const LIST_COLS = `b.*, v.name AS vendor_name,
  (SELECT row_to_json(m) FROM (SELECT id, action, occurred_at, driver_name, truck, customer_name, source FROM box_moves WHERE id = b.last_move_id) m) AS last_move`;

function shapeBox(r) {
  const daysOnSite = r.status === "customer" && r.placed_at ? Math.floor((Date.now() - new Date(r.placed_at)) / 86400000) : null;
  return { ...r, days_on_site: daysOnSite };
}

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT ${LIST_COLS} FROM boxes b LEFT JOIN vendors v ON v.id = b.vendor_id ORDER BY b.active DESC, b.home_yard, b.kind, b.number`);
  res.json(rows.map(shapeBox));
});

// Quick lookup for the driver page as they type: exact key match first, then prefix matches.
router.get("/lookup", requireAuth, async (req, res) => {
  const k = boxKey(req.query.number);
  if (!k) return res.json([]);
  const { rows } = await query("SELECT id, number, kind, size, status, current_yard, customer_name, site FROM boxes WHERE active = true");
  const exact = rows.filter((r) => boxKey(r.number) === k);
  const near = rows.filter((r) => boxKey(r.number) !== k && boxKey(r.number).startsWith(k)).slice(0, 8);
  res.json([...exact, ...near]);
});

// Customer names drivers can pick from: everyone who has (or had) a box, plus dealers on file.
router.get("/customers", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const { rows } = await query(
    `SELECT name, MAX(site) AS site, MAX(vendor_id) AS vendor_id, MIN(rank) AS rank FROM (
       SELECT customer_name AS name, site, vendor_id, 0 AS rank FROM boxes WHERE customer_name ILIKE $1
       UNION ALL SELECT customer_name, site, vendor_id, 1 FROM box_moves WHERE customer_name ILIKE $1 AND voided_at IS NULL
       UNION ALL SELECT name, NULL, id, 2 FROM vendors WHERE name ILIKE $1 AND COALESCE(active, true)
     ) x WHERE name IS NOT NULL AND name NOT LIKE 'UNKNOWN%' GROUP BY name ORDER BY MIN(rank), name LIMIT 12`,
    [like]
  );
  res.json(rows);
});

router.get("/summary", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT COALESCE(current_yard, home_yard) AS yard, kind, status, COUNT(*)::int AS n
     FROM boxes WHERE active = true GROUP BY 1,2,3 ORDER BY 1,2,3`
  );
  const { rows: todays } = await query(
    `SELECT COUNT(*)::int AS moves, COUNT(*) FILTER (WHERE array_length(warnings,1) > 0)::int AS flagged
     FROM box_moves WHERE voided_at IS NULL AND occurred_at >= now() - interval '24 hours'`
  );
  const { rows: review } = await query("SELECT COUNT(*)::int AS n FROM boxes WHERE active AND needs_review");
  res.json({ counts: rows, last24h: todays[0], needsReview: review[0].n });
});

function validBox(body, partial) {
  if (!partial && !String(body.number || "").trim()) return "number is required";
  if (body.kind !== undefined && !KINDS.includes(body.kind)) return `kind must be one of ${KINDS.join(", ")}`;
  if (body.status !== undefined && !STATUSES.includes(body.status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (body.homeYard !== undefined && !YARD_CODES.includes(body.homeYard)) return `homeYard must be one of ${YARD_CODES.join(", ")}`;
  return null;
}

router.post("/", requireAuth, requirePermission("manageBoxes"), async (req, res) => {
  const b = req.body || {};
  const err = validBox(b, false);
  if (err) return res.status(400).json({ error: err });
  const { rows: all } = await query("SELECT number FROM boxes");
  if (all.some((r) => boxKey(r.number) === boxKey(b.number))) return res.status(409).json({ error: `Box ${b.number} is already on the list` });
  const { rows } = await query(
    `INSERT INTO boxes (number, kind, size, style, home_yard, status, current_yard, customer_name, site, placed_at, notes, qb_account, qb_book_value, needs_review, review_note)
     VALUES ($1,COALESCE($2,'Roll-off'),$3,$4,COALESCE($5,'SB'),COALESCE($6,'yard'),$7,$8,$9,$10,$11,$12,$13,COALESCE($14,false),$15) RETURNING *`,
    [b.number.trim(), b.kind, b.size || null, b.style || null, b.homeYard, b.status, b.currentYard || b.homeYard || "SB",
     b.customerName || null, b.site || null, b.placedAt || null, b.notes || null, b.qbAccount || null, b.qbBookValue ?? null, b.needsReview, b.reviewNote || null]
  );
  await logAudit({ query }, { userId: req.user.id, action: "box.create", entity: "box", entityId: rows[0].id, details: { number: rows[0].number } });
  res.status(201).json(shapeBox(rows[0]));
});

router.patch("/:id", requireAuth, requirePermission("manageBoxes"), async (req, res) => {
  const b = req.body || {};
  const err = validBox(b, true);
  if (err) return res.status(400).json({ error: err });
  const map = { number: "number", kind: "kind", size: "size", style: "style", homeYard: "home_yard", status: "status", currentYard: "current_yard",
    customerName: "customer_name", site: "site", placedAt: "placed_at", notes: "notes", needsReview: "needs_review", reviewNote: "review_note",
    active: "active", qbAccount: "qb_account", qbBookValue: "qb_book_value", vendorId: "vendor_id" };
  const sets = [], vals = [req.params.id];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    vals.push(b[k] === "" ? null : b[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to change" });
  const { rows: before } = await query("SELECT * FROM boxes WHERE id = $1", [req.params.id]);
  if (!before.length) return res.status(404).json({ error: "Not found" });
  const { rows } = await query(`UPDATE boxes SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
  await logAudit({ query }, { userId: req.user.id, action: "box.edit", entity: "box", entityId: req.params.id, details: { changes: b } });
  res.json(shapeBox(rows[0]));
});

// Office confirms the box against the paper count (or un-confirms it).
router.post("/:id/verify", requireAuth, requirePermission("manageBoxes"), async (req, res) => {
  const on = (req.body || {}).verified !== false;
  const { rows } = await query(
    `UPDATE boxes SET verified_at = CASE WHEN $2 THEN now() ELSE NULL END, verified_by = CASE WHEN $2 THEN $3 ELSE NULL END,
       needs_review = CASE WHEN $2 THEN false ELSE needs_review END, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, on, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(shapeBox(rows[0]));
});

// Bulk load / refresh of the box list (the ScrapDragon + QuickBooks reconciliation lands here).
// Matches on the normalized box number; existing boxes are updated, new ones created.
router.post("/import", requireAuth, requirePermission("manageBoxes"), async (req, res) => {
  const list = (req.body || {}).rows;
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: "rows must be a non-empty list" });
  const client = await pool.connect();
  let created = 0, updated = 0; const skipped = [];
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query("SELECT id, number FROM boxes");
    const byKey = new Map(existing.map((r) => [boxKey(r.number), r.id]));
    for (const r of list) {
      const err = validBox(r, false);
      if (err) { skipped.push({ number: r.number, error: err }); continue; }
      const vals = [r.number.trim(), r.kind || "Roll-off", r.size || null, r.style || null, r.homeYard || "SB", r.status || "yard",
        r.currentYard || r.homeYard || "SB", r.customerName || null, r.site || null, r.placedAt || null,
        r.sdContainerId || null, r.sdSnapshot ? JSON.stringify(r.sdSnapshot) : null, r.qbAccount || null, r.qbBookValue ?? null,
        !!r.needsReview, r.reviewNote || null, r.notes || null, r.active !== false];
      const id = byKey.get(boxKey(r.number));
      if (id) {
        await client.query(
          `UPDATE boxes SET number=$1, kind=$2, size=$3, style=$4, home_yard=$5, status=$6, current_yard=$7, customer_name=$8, site=$9, placed_at=$10,
             sd_container_id=$11, sd_snapshot=$12, qb_account=$13, qb_book_value=$14, needs_review=$15, review_note=$16, notes=$17, active=$18, updated_at=now()
           WHERE id = $19`, [...vals, id]);
        updated++;
      } else {
        const { rows } = await client.query(
          `INSERT INTO boxes (number, kind, size, style, home_yard, status, current_yard, customer_name, site, placed_at,
             sd_container_id, sd_snapshot, qb_account, qb_book_value, needs_review, review_note, notes, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, vals);
        byKey.set(boxKey(r.number), rows[0].id);
        created++;
      }
    }
    await logAudit(client, { userId: req.user.id, action: "box.import", entity: "box", details: { created, updated, skipped: skipped.length } });
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  res.json({ created, updated, skipped });
});

/* ---------------------------------- moves ---------------------------------- */

const MOVE_COLS = `m.id, m.created_at, m.occurred_at, m.action, m.yard, m.customer_name, m.site, m.box_in_id, m.box_out_id,
  m.box_in_number, m.box_out_number, m.new_status, m.truck, m.driver_name, m.lat, m.lng, m.accuracy_m, m.notes, m.source,
  m.warnings, m.voided_at, m.void_reason, (m.photo IS NOT NULL) AS has_photo, m.job_id,
  (SELECT 'J-' || job_no FROM box_jobs WHERE id = m.job_id) AS job_label,
  bi.number AS box_in, bo.number AS box_out, u.name AS entered_by`;

router.get("/moves", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const vals = [limit]; const where = [];
  if (req.query.boxId) { vals.push(req.query.boxId); where.push(`(m.box_in_id = $${vals.length} OR m.box_out_id = $${vals.length})`); }
  if (req.query.since) { vals.push(req.query.since); where.push(`m.occurred_at >= $${vals.length}`); }
  if (req.query.mine === "1") { vals.push(req.user.id); where.push(`m.user_id = $${vals.length}`); }
  const { rows } = await query(
    `SELECT ${MOVE_COLS} FROM box_moves m LEFT JOIN boxes bi ON bi.id = m.box_in_id LEFT JOIN boxes bo ON bo.id = m.box_out_id
     LEFT JOIN users u ON u.id = m.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.occurred_at DESC LIMIT $1`, vals);
  res.json(rows);
});

router.get("/moves/:id/photo", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT photo FROM box_moves WHERE id = $1", [req.params.id]);
  if (!rows.length || !rows[0].photo) return res.status(404).json({ error: "No photo" });
  res.json({ photo: rows[0].photo });
});

// Find the box a driver typed, or (so the driver is never stuck at a customer's gate) add it to the
// list flagged for the office to review.
async function resolveBox(client, typed, ctx, warnings, created) {
  const k = boxKey(typed);
  if (!k) return null;
  const { rows } = await client.query("SELECT * FROM boxes");
  const hit = rows.find((r) => boxKey(r.number) === k);
  if (hit) {
    const { rows: locked } = await client.query("SELECT * FROM boxes WHERE id = $1 FOR UPDATE", [hit.id]);
    return locked[0];
  }
  const kind = /^[LM]-?\d/i.test(k) ? "Lugger" : /^SD-/.test(k) ? "Hopper" : "Roll-off";
  const { rows: ins } = await client.query(
    `INSERT INTO boxes (number, kind, home_yard, status, current_yard, needs_review, review_note)
     VALUES ($1,$2,$3,'yard',$3,true,$4) RETURNING *`,
    [String(typed).trim().toUpperCase(), kind, ctx.yard || "SB", `Not on the box list — first entered by ${ctx.who} on ${new Date().toISOString().slice(0, 10)}. Check the number.`]
  );
  warnings.push(`Box ${typed} wasn't on the list — added it and flagged it for the office.`);
  created.push(ins[0].number);
  return ins[0];
}

const snap = (b) => b && ({ status: b.status, current_yard: b.current_yard, customer_name: b.customer_name, vendor_id: b.vendor_id, site: b.site,
  placed_at: b.placed_at, last_moved_at: b.last_moved_at, last_move_id: b.last_move_id, needs_review: b.needs_review, review_note: b.review_note });
const where = (b) => (b.status === "customer" ? `at ${b.customer_name || "a customer"}` : b.status === "yard" ? `at the ${b.current_yard || b.home_yard} yard` : `marked ${b.status}`);
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

router.post("/moves", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!ACTIONS.includes(b.action)) return res.status(400).json({ error: `action must be one of ${ACTIONS.join(", ")}` });
  const needsIn = ["drop", "swap", "yard_move", "status", "correction"].includes(b.action);
  const needsOut = ["pickup", "swap"].includes(b.action);
  if (needsIn && !String(b.boxIn || "").trim()) return res.status(400).json({ error: b.action === "swap" ? "Enter the box you dropped" : "Enter the box number" });
  if (needsOut && !String(b.boxOut || "").trim()) return res.status(400).json({ error: "Enter the box you picked up" });
  if (["drop", "swap", "pickup"].includes(b.action) && !String(b.customerName || "").trim()) return res.status(400).json({ error: "Enter the customer" });
  if (b.action === "swap" && boxKey(b.boxIn) === boxKey(b.boxOut)) return res.status(400).json({ error: "The dropped and picked-up box can't be the same number" });
  if (b.action === "status" && !STATUSES.includes(b.newStatus)) return res.status(400).json({ error: `newStatus must be one of ${STATUSES.join(", ")}` });
  const yard = YARD_CODES.includes(b.yard) ? b.yard : (req.user.home_yard || "SB");
  const isOffice = b.source === "office" && userCan(req.user, "manageBoxes");
  if (b.action === "correction" && !isOffice) return res.status(403).json({ error: "Only the office can post a correction" });
  if (b.photo && (typeof b.photo !== "string" || !b.photo.startsWith("data:image/") || b.photo.length > 1_500_000)) return res.status(400).json({ error: "Photo must be a JPEG/PNG under about 1 MB" });
  const occurredAt = b.occurredAt && !isNaN(new Date(b.occurredAt)) ? new Date(b.occurredAt) : new Date();
  if (occurredAt > new Date(Date.now() + 10 * 60000)) return res.status(400).json({ error: "That time is in the future" });

  // A move made from a job on the driver's board closes that job. Only the job's driver or a
  // dispatcher can close it; if the office cancelled or finished it meanwhile (phone was offline),
  // the box move still counts — the box really moved — and the warning says so.
  if (b.jobId) {
    const { rows: jr } = await query("SELECT driver_id FROM box_jobs WHERE id = $1", [String(b.jobId)]);
    if (!jr.length) return res.status(400).json({ error: "That job doesn't exist" });
    if (jr[0].driver_id && jr[0].driver_id !== req.user.id && !userCan(req.user, "dispatchBoxes") && !userCan(req.user, "manageBoxes"))
      return res.status(403).json({ error: "This job isn't on your board" });
  }

  if (b.clientId) {
    const { rows: dup } = await query("SELECT id, warnings FROM box_moves WHERE client_id = $1", [String(b.clientId)]);
    if (dup.length) return res.json({ id: dup[0].id, duplicate: true, warnings: dup[0].warnings || [] });
  }

  const client = await pool.connect();
  const warnings = [], created = [];
  let moveId;
  try {
    await client.query("BEGIN");
    const who = b.driverName || req.user.name;
    const ctx = { yard, who };
    const boxIn = needsIn ? await resolveBox(client, b.boxIn, ctx, warnings, created) : null;
    const boxOut = needsOut ? await resolveBox(client, b.boxOut, ctx, warnings, created) : null;
    const prevIn = snap(boxIn), prevOut = snap(boxOut);
    const customer = String(b.customerName || "").trim() || null;
    const flags = { in: [], out: [] };
    let job = null;
    if (b.jobId) {
      const { rows: jr } = await client.query("SELECT * FROM box_jobs WHERE id = $1 FOR UPDATE", [String(b.jobId)]);
      job = jr[0];
      if (job.status === "cancelled") { warnings.push(`Job J-${job.job_no} had been cancelled by the office — the box move was still recorded.`); job = null; }
      else if (job.status === "done") { warnings.push(`Job J-${job.job_no} was already finished — this was recorded as a separate move.`); job = null; }
    }

    // Sanity checks: these are the discrepancies the paper count is looking for.
    if (boxIn && ["drop", "swap"].includes(b.action)) {
      if (boxIn.status === "customer" && !same(boxIn.customer_name, customer)) flags.in.push(`Box ${boxIn.number} was showing ${where(boxIn)} — now dropped at ${customer}.`);
      if (["retired", "missing"].includes(boxIn.status)) flags.in.push(`Box ${boxIn.number} was marked ${boxIn.status}.`);
    }
    if (boxOut) {
      if (boxOut.status !== "customer") flags.out.push(`Box ${boxOut.number} was showing ${where(boxOut)}, not at ${customer}.`);
      else if (!same(boxOut.customer_name, customer)) flags.out.push(`Box ${boxOut.number} was showing at ${boxOut.customer_name}, not ${customer}.`);
    }
    warnings.push(...flags.in, ...flags.out);

    // A late send from a phone that was offline must not overwrite a newer move already on the box.
    const stale = (box) => box && box.last_moved_at && new Date(box.last_moved_at) > occurredAt;
    const { rows: mv } = await client.query(
      `INSERT INTO box_moves (occurred_at, action, yard, customer_name, vendor_id, site, box_in_id, box_out_id, box_in_number, box_out_number,
         new_status, truck, driver_name, user_id, lat, lng, accuracy_m, photo, notes, source, prev_in, prev_out, client_id, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [occurredAt, b.action, yard, customer, b.vendorId || null, b.site || null, boxIn?.id || null, boxOut?.id || null,
       needsIn ? String(b.boxIn).trim() : null, needsOut ? String(b.boxOut).trim() : null, b.action === "status" ? b.newStatus : null,
       b.truck || null, who, req.user.id, b.lat ?? null, b.lng ?? null, b.accuracy != null ? Math.round(b.accuracy) : null,
       b.photo || null, b.notes || null, isOffice ? "office" : "driver", prevIn ? JSON.stringify(prevIn) : null,
       prevOut ? JSON.stringify(prevOut) : null, b.clientId ? String(b.clientId) : null, warnings]
    );
    moveId = mv[0].id;
    if (job) {
      await client.query("UPDATE box_moves SET job_id = $2 WHERE id = $1", [moveId, job.id]);
      await client.query(
        `UPDATE box_jobs SET status='done', completed_at=$2, completed_by=$3, move_id=$4, driver_id=COALESCE(driver_id,$3),
           started_at=COALESCE(started_at,$2), driver_notes=COALESCE($5, driver_notes), updated_at=now() WHERE id=$1`,
        [job.id, occurredAt, req.user.id, moveId, b.notes || null]);
    }

    const review = (list) => (list.length ? list.join(" ") : null);
    if (boxIn && !stale(boxIn)) {
      let next;
      if (["drop", "swap"].includes(b.action)) next = { status: "customer", current_yard: yard, customer_name: customer, vendor_id: b.vendorId || null, site: b.site || null, placed_at: occurredAt };
      else if (b.action === "yard_move") next = { status: "yard", current_yard: yard, customer_name: null, vendor_id: null, site: null, placed_at: null };
      else if (b.action === "correction") next = customer
        ? { status: "customer", current_yard: yard, customer_name: customer, vendor_id: b.vendorId || null, site: b.site || null, placed_at: b.placedAt ? new Date(b.placedAt) : occurredAt }
        : { status: "yard", current_yard: yard, customer_name: null, vendor_id: null, site: null, placed_at: null };
      else next = { status: b.newStatus, current_yard: b.newStatus === "yard" ? yard : boxIn.current_yard, customer_name: b.newStatus === "yard" ? null : boxIn.customer_name, vendor_id: boxIn.vendor_id, site: boxIn.site, placed_at: b.newStatus === "yard" ? null : boxIn.placed_at };
      const r = review(flags.in);
      await client.query(
        `UPDATE boxes SET status=$2, current_yard=$3, customer_name=$4, vendor_id=$5, site=$6, placed_at=$7, last_moved_at=$8, last_move_id=$9,
           needs_review = needs_review OR $10, review_note = CASE WHEN $10 THEN $11 ELSE review_note END, updated_at=now() WHERE id=$1`,
        [boxIn.id, next.status, next.current_yard, next.customer_name, next.vendor_id, next.site, next.placed_at, occurredAt, moveId, !!r, r]
      );
    } else if (boxIn) warnings.push(`Box ${boxIn.number} already has a newer move on it — this one was logged but didn't change where it shows.`);
    if (boxOut && !stale(boxOut)) {
      const r = review(flags.out);
      await client.query(
        `UPDATE boxes SET status='yard', current_yard=$2, customer_name=NULL, vendor_id=NULL, site=NULL, placed_at=NULL, last_moved_at=$3, last_move_id=$4,
           needs_review = needs_review OR $5, review_note = CASE WHEN $5 THEN $6 ELSE review_note END, updated_at=now() WHERE id=$1`,
        [boxOut.id, yard, occurredAt, moveId, !!r, r]
      );
    } else if (boxOut) warnings.push(`Box ${boxOut.number} already has a newer move on it — this one was logged but didn't change where it shows.`);
    if (warnings.length) await client.query("UPDATE box_moves SET warnings = $2 WHERE id = $1", [moveId, warnings]);
    await logAudit(client, { userId: req.user.id, action: `box.${b.action}`, entity: "box_move", entityId: moveId, details: { in: b.boxIn, out: b.boxOut, customer } });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505" && b.clientId) {
      const { rows: dup } = await query("SELECT id, warnings FROM box_moves WHERE client_id = $1", [String(b.clientId)]);
      if (dup.length) return res.json({ id: dup[0].id, duplicate: true, warnings: dup[0].warnings || [] });
    }
    throw e;
  } finally { client.release(); }
  res.status(201).json({ id: moveId, warnings, createdBoxes: created });
});

// Undo a move. If it is still the latest move on a box, the box goes back to where it was before;
// otherwise the move is just marked void and the box is flagged for the office to set by hand.
router.post("/moves/:id/void", requireAuth, requirePermission("manageBoxes"), async (req, res) => {
  const client = await pool.connect();
  const notes = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM box_moves WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    const m = rows[0];
    if (m.voided_at) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Already voided" }); }
    for (const [boxId, prev] of [[m.box_in_id, m.prev_in], [m.box_out_id, m.prev_out]]) {
      if (!boxId) continue;
      const { rows: bx } = await client.query("SELECT * FROM boxes WHERE id = $1 FOR UPDATE", [boxId]);
      const box = bx[0];
      if (box.last_move_id === m.id && prev) {
        await client.query(
          `UPDATE boxes SET status=$2, current_yard=$3, customer_name=$4, vendor_id=$5, site=$6, placed_at=$7, last_moved_at=$8, last_move_id=$9,
             needs_review=$10, review_note=$11, updated_at=now() WHERE id=$1`,
          [boxId, prev.status, prev.current_yard, prev.customer_name, prev.vendor_id, prev.site, prev.placed_at, prev.last_moved_at, prev.last_move_id, prev.needs_review, prev.review_note]
        );
        notes.push(`Box ${box.number} put back ${where(prev)}.`);
      } else {
        await client.query("UPDATE boxes SET needs_review = true, review_note = $2, updated_at = now() WHERE id = $1",
          [boxId, `A move on this box was voided but a newer move exists — confirm where ${box.number} really is.`]);
        notes.push(`Box ${box.number} has a newer move, so it was left where it is and flagged for review.`);
      }
    }
    await client.query("UPDATE box_moves SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [m.id, req.user.id, (req.body || {}).reason || null]);
    if (m.job_id) {
      const { rows: jr } = await client.query(
        `UPDATE box_jobs SET status = CASE WHEN driver_id IS NULL THEN 'open' ELSE 'assigned' END, completed_at=NULL, completed_by=NULL, move_id=NULL, updated_at=now()
         WHERE id = $1 AND move_id = $2 RETURNING job_no`, [m.job_id, m.id]);
      if (jr.length) notes.push(`Job J-${jr[0].job_no} is back on the board.`);
    }
    await logAudit(client, { userId: req.user.id, action: "box.void", entity: "box_move", entityId: m.id, details: { reason: (req.body || {}).reason } });
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  res.json({ ok: true, notes });
});

module.exports = router;
module.exports.boxKey = boxKey;
