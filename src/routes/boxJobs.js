// Box jobs: a customer calls for a swap / drop / pick-up, the scale operator logs it and puts it on a
// driver's board, and the driver finishes it from the phone page (/driver). Finishing a swap, drop or
// pick-up posts a box move through POST /boxes/moves with this job's id, which closes the job in the
// same transaction (see src/routes/boxes.js). Dump-and-return and "other" jobs don't move a box, so
// they finish here with POST /box-jobs/:id/complete.
const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission, userCan } = require("../middleware/auth");
const { logAudit } = require("../audit");

const router = express.Router();
const TASKS = ["swap", "drop", "pickup", "dump_return", "other"];
const OPEN = ["open", "assigned", "started"];
const YARD_CODES = ["SB", "HAYS", "COLBY", "RC"];

const COLS = `j.*, 'J-' || j.job_no AS job_label, d.name AS driver_name, cu.name AS created_by_name, fu.name AS completed_by_name,
  (SELECT row_to_json(m) FROM (SELECT mv.id, mv.action, mv.occurred_at, mv.box_in_number, mv.box_out_number, mv.warnings, mv.voided_at,
     bi.number AS box_in, bo.number AS box_out
     FROM box_moves mv LEFT JOIN boxes bi ON bi.id = mv.box_in_id LEFT JOIN boxes bo ON bo.id = mv.box_out_id WHERE mv.id = j.move_id) m) AS move`;
const FROM = `FROM box_jobs j LEFT JOIN users d ON d.id = j.driver_id LEFT JOIN users cu ON cu.id = j.created_by LEFT JOIN users fu ON fu.id = j.completed_by`;

async function one(id) {
  const { rows } = await query(`SELECT ${COLS} ${FROM} WHERE j.id = $1`, [id]);
  return rows[0] || null;
}
const isDispatcher = (u) => userCan(u, "dispatchBoxes") || userCan(u, "manageBoxes");
const clean = (v) => (v === undefined ? undefined : (String(v ?? "").trim() || null));

// GET /box-jobs?scope=board|mine|history&yard=SB&days=14
//   board   (default) open jobs plus anything finished or cancelled in the last 24 hours
//   mine    the signed-in driver's open jobs plus what they finished today
//   history everything in the last `days` days
router.get("/", requireAuth, async (req, res) => {
  const scope = req.query.scope || "board";
  const vals = []; const where = [];
  if (scope === "mine") {
    vals.push(req.user.id); where.push(`j.driver_id = $${vals.length}`);
    where.push(`(j.status IN ('assigned','started') OR (j.status = 'done' AND j.completed_at > now() - interval '18 hours'))`);
  } else if (scope === "history") {
    vals.push(Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 366));
    where.push(`j.created_at > now() - ($${vals.length} || ' days')::interval`);
  } else {
    where.push(`(j.status IN ('open','assigned','started') OR COALESCE(j.completed_at, j.cancelled_at) > now() - interval '24 hours')`);
  }
  if (req.query.yard && YARD_CODES.includes(req.query.yard)) { vals.push(req.query.yard); where.push(`j.yard = $${vals.length}`); }
  const { rows } = await query(
    `SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")}
     ORDER BY CASE j.status WHEN 'started' THEN 0 WHEN 'assigned' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
              j.board_order, (j.priority = 'urgent') DESC, j.requested_for NULLS FIRST, j.created_at`, vals);
  res.json(rows);
});

// Everyone who can be put on a board: active users in the Driver role, plus anyone who already has
// an open job (so a job assigned to a yard hand who also drives doesn't vanish from the board).
router.get("/drivers", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.home_yard, u.yards, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.active = true AND (r.name = 'Driver' OR u.id IN (SELECT driver_id FROM box_jobs WHERE status IN ('assigned','started') AND driver_id IS NOT NULL))
     ORDER BY u.name`);
  res.json(rows);
});

async function nextOrder(client, driverId) {
  const { rows } = await client.query(
    "SELECT COALESCE(MAX(board_order), 0) + 1 AS n FROM box_jobs WHERE status IN ('open','assigned','started') AND driver_id IS NOT DISTINCT FROM $1", [driverId || null]);
  return rows[0].n;
}
async function checkDriver(driverId) {
  if (!driverId) return null;
  const { rows } = await query("SELECT id FROM users WHERE id = $1 AND active = true", [driverId]);
  return rows.length ? null : "That driver isn't an active user";
}

router.post("/", requireAuth, requirePermission("dispatchBoxes"), async (req, res) => {
  const b = req.body || {};
  if (!TASKS.includes(b.task)) return res.status(400).json({ error: `task must be one of ${TASKS.join(", ")}` });
  if (!String(b.customerName || "").trim()) return res.status(400).json({ error: "Enter the customer" });
  const yard = YARD_CODES.includes(b.yard) ? b.yard : (req.user.home_yard || "SB");
  const dErr = await checkDriver(b.driverId); if (dErr) return res.status(400).json({ error: dErr });
  if (b.requestedFor && isNaN(new Date(b.requestedFor))) return res.status(400).json({ error: "requestedFor must be a date" });
  const client = await pool.connect();
  let id;
  try {
    await client.query("BEGIN");
    const order = await nextOrder(client, b.driverId);
    const { rows } = await client.query(
      `INSERT INTO box_jobs (created_by, yard, task, customer_name, vendor_id, site, contact_name, contact_phone, box_kind, box_size, box_number,
         requested_for, priority, driver_id, board_order, status, office_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, job_no`,
      [req.user.id, yard, b.task, String(b.customerName).trim(), b.vendorId || null, clean(b.site), clean(b.contactName), clean(b.contactPhone),
       clean(b.boxKind), clean(b.boxSize), clean(b.boxNumber) ? String(b.boxNumber).trim().toUpperCase() : null, b.requestedFor || null,
       b.priority === "urgent" ? "urgent" : "normal", b.driverId || null, order, b.driverId ? "assigned" : "open", clean(b.officeNotes)]);
    id = rows[0].id;
    await logAudit(client, { userId: req.user.id, action: "boxjob.create", entity: "box_job", entityId: id, details: { task: b.task, customer: b.customerName, driverId: b.driverId || null } });
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  res.status(201).json(await one(id));
});

// Edit the request, put it on a driver's board (driverId), take it off (driverId: ""), or move it
// up / down that board (move: "up" | "down").
router.patch("/:id", requireAuth, requirePermission("dispatchBoxes"), async (req, res) => {
  const b = req.body || {};
  const job = await one(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (!OPEN.includes(job.status)) return res.status(400).json({ error: `Job is ${job.status} — reopen it first` });
  if (b.task !== undefined && !TASKS.includes(b.task)) return res.status(400).json({ error: `task must be one of ${TASKS.join(", ")}` });
  if (b.customerName !== undefined && !String(b.customerName || "").trim()) return res.status(400).json({ error: "Enter the customer" });
  if (b.yard !== undefined && !YARD_CODES.includes(b.yard)) return res.status(400).json({ error: "Unknown yard" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM box_jobs WHERE id = $1 FOR UPDATE", [job.id]);
    if (b.driverId !== undefined && (b.driverId || null) !== (job.driver_id || null)) {
      const dErr = await checkDriver(b.driverId); if (dErr) { await client.query("ROLLBACK"); return res.status(400).json({ error: dErr }); }
      const order = await nextOrder(client, b.driverId);
      const status = b.driverId ? (job.status === "started" ? "started" : "assigned") : "open";
      await client.query("UPDATE box_jobs SET driver_id=$2, board_order=$3, status=$4, started_at = CASE WHEN $4='open' THEN NULL ELSE started_at END WHERE id=$1",
        [job.id, b.driverId || null, order, status]);
    }
    if (b.move === "up" || b.move === "down") {
      const { rows: cur } = await client.query("SELECT driver_id, board_order FROM box_jobs WHERE id = $1", [job.id]);
      const { rows: nb } = await client.query(
        `SELECT id, board_order FROM box_jobs WHERE status IN ('open','assigned','started') AND driver_id IS NOT DISTINCT FROM $1 AND id <> $2
           AND board_order ${b.move === "up" ? "<=" : ">="} $3 ORDER BY board_order ${b.move === "up" ? "DESC" : "ASC"} LIMIT 1`,
        [cur[0].driver_id, job.id, cur[0].board_order]);
      if (nb.length) {
        const mine = cur[0].board_order === nb[0].board_order ? nb[0].board_order + (b.move === "up" ? -1 : 1) : nb[0].board_order;
        await client.query("UPDATE box_jobs SET board_order = $2 WHERE id = $1", [nb[0].id, cur[0].board_order]);
        await client.query("UPDATE box_jobs SET board_order = $2 WHERE id = $1", [job.id, mine]);
      }
    }
    const fields = { task: b.task, customer_name: b.customerName !== undefined ? String(b.customerName).trim() : undefined, vendor_id: b.vendorId,
      site: clean(b.site), contact_name: clean(b.contactName), contact_phone: clean(b.contactPhone), box_kind: clean(b.boxKind), box_size: clean(b.boxSize),
      box_number: b.boxNumber === undefined ? undefined : (clean(b.boxNumber) ? String(b.boxNumber).trim().toUpperCase() : null),
      requested_for: b.requestedFor === undefined ? undefined : (b.requestedFor || null),
      priority: b.priority === undefined ? undefined : (b.priority === "urgent" ? "urgent" : "normal"), office_notes: clean(b.officeNotes), yard: b.yard };
    const set = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (set.length) await client.query(`UPDATE box_jobs SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [job.id, ...set.map(([, v]) => v)]);
    await client.query("UPDATE box_jobs SET updated_at = now() WHERE id = $1", [job.id]);
    await logAudit(client, { userId: req.user.id, action: "boxjob.edit", entity: "box_job", entityId: job.id, details: b });
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  res.json(await one(job.id));
});

// The driver has opened the job on the phone (or the office marks it rolling).
router.post("/:id/start", requireAuth, async (req, res) => {
  const job = await one(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.driver_id !== req.user.id && !isDispatcher(req.user)) return res.status(403).json({ error: "This job isn't on your board" });
  if (job.status === "assigned" || job.status === "open") {
    await query("UPDATE box_jobs SET status='started', started_at=COALESCE(started_at, now()), driver_id=COALESCE(driver_id, $2), updated_at=now() WHERE id=$1", [job.id, req.user.id]);
  }
  // The truck the driver is in — mileage for this job comes off that truck's odometer.
  const truck = String((req.body || {}).truck || "").trim();
  if (truck) await query("UPDATE box_jobs SET truck = $2 WHERE id = $1", [job.id, truck]);
  res.json(await one(job.id));
});

// Finish a job that doesn't move a box (dump-and-return, other). Swaps / drops / pick-ups finish by
// posting the box move with jobId instead, so the box list stays right.
router.post("/:id/complete", requireAuth, async (req, res) => {
  const b = req.body || {};
  const job = await one(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.driver_id !== req.user.id && !isDispatcher(req.user)) return res.status(403).json({ error: "This job isn't on your board" });
  if (job.status === "done") return res.json(job);                       // a retried send from an offline phone
  if (job.status === "cancelled") return res.status(409).json({ error: "The office cancelled this job" });
  if (["swap", "drop", "pickup"].includes(job.task) && !b.force) return res.status(400).json({ error: "Record the box move to finish this job" });
  const at = b.occurredAt && !isNaN(new Date(b.occurredAt)) ? new Date(b.occurredAt) : new Date();
  await query(`UPDATE box_jobs SET status='done', completed_at=$2, completed_by=$3, driver_notes=$4, driver_id=COALESCE(driver_id,$3),
     started_at=COALESCE(started_at,$2), updated_at=now() WHERE id=$1`, [job.id, at, req.user.id, clean(b.notes)]);
  await logAudit({ query }, { userId: req.user.id, action: "boxjob.complete", entity: "box_job", entityId: job.id, details: { notes: b.notes || null } });
  res.json(await one(job.id));
});

router.post("/:id/cancel", requireAuth, requirePermission("dispatchBoxes"), async (req, res) => {
  const job = await one(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (!OPEN.includes(job.status)) return res.status(400).json({ error: `Job is already ${job.status}` });
  await query("UPDATE box_jobs SET status='cancelled', cancelled_at=now(), cancelled_by=$2, cancel_reason=$3, updated_at=now() WHERE id=$1",
    [job.id, req.user.id, clean((req.body || {}).reason)]);
  await logAudit({ query }, { userId: req.user.id, action: "boxjob.cancel", entity: "box_job", entityId: job.id, details: { reason: (req.body || {}).reason || null } });
  res.json(await one(job.id));
});

// Put a finished or cancelled job back on the board. A job finished by a box move can only come back
// by voiding that move (Freight → Boxes → Driver log), so the box list and the job never disagree.
router.post("/:id/reopen", requireAuth, requirePermission("dispatchBoxes"), async (req, res) => {
  const job = await one(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (OPEN.includes(job.status)) return res.json(job);
  if (job.move && !job.move.voided_at) return res.status(400).json({ error: "This job was finished by a box move — void that entry in the Driver log to reopen it" });
  await query(`UPDATE box_jobs SET status = CASE WHEN driver_id IS NULL THEN 'open' ELSE 'assigned' END, completed_at=NULL, completed_by=NULL,
     move_id=NULL, cancelled_at=NULL, cancelled_by=NULL, cancel_reason=NULL, updated_at=now() WHERE id=$1`, [job.id]);
  await logAudit({ query }, { userId: req.user.id, action: "boxjob.reopen", entity: "box_job", entityId: job.id });
  res.json(await one(job.id));
});

module.exports = router;
