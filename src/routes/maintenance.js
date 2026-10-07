// Maintenance: assets, PM schedules, work orders, inspections. Mounted at /maintenance.
// Any logged-in user can log inspections and move work orders (mechanics and operators are the
// people doing the work); turning failed inspection items into work orders needs
// assignWorkOrderItems, matching the UI.
const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission, userCan } = require("../middleware/auth");
const { logAudit } = require("../audit");

const router = express.Router();

const ASSET_STATUSES = ["up", "down"];
const METER_TYPES = ["Hours", "Miles"];
const WO_STATUSES = ["unassigned", "not_started", "in_progress", "waiting", "review", "complete"];
const YARD_CODE = { SB: "SB", HAYS: "HA", COLBY: "CO", RC: "RC" };
const MAX_INVOICE_BYTES = 4 * 1024 * 1024;

function fail(res, status, msg) { res.status(status).json({ error: msg }); return null; }
function todayIso() { return new Date().toISOString().slice(0, 10); }

// ---------- Assets ----------
router.get("/assets", requireAuth, async (req, res) => {
  const { yard, includeInactive } = req.query;
  const clauses = []; const params = [];
  if (yard) { params.push(yard); clauses.push(`yard = $${params.length}`); }
  if (includeInactive !== "true") clauses.push("active = true");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query(`SELECT * FROM assets ${where} ORDER BY yard, id`, params);
  res.json(rows);
});

router.post("/assets", requireAuth, async (req, res) => {
  const { id, yard, year, make, model, type, meterType, meter, notes } = req.body || {};
  if (!id || !id.trim()) return fail(res, 400, "id (fleet / asset number) is required");
  if (!yard || !type) return fail(res, 400, "yard and type are required");
  if (meterType !== undefined && !METER_TYPES.includes(meterType)) return fail(res, 400, "meterType must be Hours or Miles");
  try {
    const { rows } = await query(
      `INSERT INTO assets (id, yard, year, make, model, type, meter_type, meter, notes)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'Hours'),COALESCE($8,0),$9) RETURNING *`,
      [id.trim().toUpperCase(), yard, year || null, make || null, model || null, type, meterType, meter, notes || null]
    );
    await logAudit(pool, { userId: req.user.id, action: "asset.create", entity: "asset", entityId: rows[0].id, details: { yard, type } });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return fail(res, 409, `Asset ${id} already exists`);
    throw e;
  }
});

router.patch("/assets/:id", requireAuth, async (req, res) => {
  const { yard, year, make, model, type, meterType, meter, status, customItems, notes, active } = req.body || {};
  if (status !== undefined && !ASSET_STATUSES.includes(status)) return fail(res, 400, "status must be up or down");
  if (meterType !== undefined && !METER_TYPES.includes(meterType)) return fail(res, 400, "meterType must be Hours or Miles");
  if (customItems !== undefined && !Array.isArray(customItems)) return fail(res, 400, "customItems must be a list");
  const { rows } = await query(
    `UPDATE assets SET yard = COALESCE($2, yard), year = COALESCE($3, year), make = COALESCE($4, make), model = COALESCE($5, model),
       type = COALESCE($6, type), meter_type = COALESCE($7, meter_type), meter = COALESCE($8, meter), status = COALESCE($9, status),
       custom_items = COALESCE($10, custom_items), notes = COALESCE($11, notes), active = COALESCE($12, active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, yard ?? null, year ?? null, make ?? null, model ?? null, type ?? null, meterType ?? null, meter ?? null, status ?? null,
     customItems !== undefined ? JSON.stringify(customItems) : null, notes ?? null, active ?? null]
  );
  if (!rows.length) return fail(res, 404, "Not found");
  if (status !== undefined || meter !== undefined) {
    await logAudit(pool, { userId: req.user.id, action: "asset.update", entity: "asset", entityId: req.params.id, details: { status, meter } });
  }
  res.json(rows[0]);
});

// ---------- PM schedules ----------
router.get("/pm", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, a.yard, a.meter AS asset_meter, a.meter_type FROM pm_schedules p JOIN assets a ON a.id = p.asset_id
     WHERE p.active = true ORDER BY a.yard, a.id, p.name`
  );
  res.json(rows);
});

router.post("/pm", requireAuth, async (req, res) => {
  const { assetId, name, trigger, interval } = req.body || {};
  if (!assetId || !name || !name.trim()) return fail(res, 400, "assetId and name are required");
  if (!["meter", "calendar"].includes(trigger)) return fail(res, 400, "trigger must be meter or calendar");
  const n = parseInt(interval, 10);
  if (!(n > 0)) return fail(res, 400, "interval must be a positive whole number");
  const { rows: a } = await query("SELECT * FROM assets WHERE id = $1", [assetId]);
  if (!a.length) return fail(res, 400, "assetId does not match any asset");
  const { rows } = await query(
    `INSERT INTO pm_schedules (asset_id, name, trigger, interval, last_done_meter, last_done_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [assetId, name.trim(), trigger, n, trigger === "meter" ? a[0].meter : null, trigger === "calendar" ? todayIso() : null]
  );
  res.status(201).json({ ...rows[0], yard: a[0].yard, asset_meter: a[0].meter, meter_type: a[0].meter_type });
});

router.patch("/pm/:id", requireAuth, async (req, res) => {
  const { name, interval, lastDoneMeter, lastDoneDate, active } = req.body || {};
  const { rows } = await query(
    `UPDATE pm_schedules SET name = COALESCE($2, name), interval = COALESCE($3, interval), last_done_meter = COALESCE($4, last_done_meter),
       last_done_date = COALESCE($5, last_done_date), active = COALESCE($6, active) WHERE id = $1 RETURNING *`,
    [req.params.id, name ?? null, interval ?? null, lastDoneMeter ?? null, lastDoneDate ?? null, active ?? null]
  );
  if (!rows.length) return fail(res, 404, "Not found");
  res.json(rows[0]);
});

async function nextWorkOrderId(client, asset) {
  const { rows } = await client.query("SELECT nextval('work_order_seq') AS n");
  const typeCode = asset.id.startsWith("E") ? "FP" : "TRAN";
  return `LIS.${YARD_CODE[asset.yard] || asset.yard}.${typeCode}.${rows[0].n}`;
}

async function notifyAssignment(client, wo, asset, userId) {
  await client.query(
    "INSERT INTO notifications (user_id, kind, message, ref_type, ref_id) VALUES ($1,'work_order_assigned',$2,'work_order',$3)",
    [userId, `You've been assigned to ${wo.id} — ${wo.title} (#${asset.id} ${asset.year || ""} ${asset.make || ""} ${asset.model || ""})`.replace(/\s+/g, " ").trim(), wo.id]
  );
}

// "Generate work order" from a PM schedule: opens a not-started WO and resets the schedule.
router.post("/pm/:id/generate", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: p } = await client.query("SELECT * FROM pm_schedules WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!p.length) { await client.query("ROLLBACK"); return fail(res, 404, "Not found"); }
    const pm = p[0];
    const { rows: a } = await client.query("SELECT * FROM assets WHERE id = $1", [pm.asset_id]);
    const asset = a[0];
    const id = await nextWorkOrderId(client, asset);
    const { rows: w } = await client.query(
      `INSERT INTO work_orders (id, asset_id, yard, title, priority, status, issued_date, meter_at_issue, from_pm_id, created_by)
       VALUES ($1,$2,$3,$4,3,'not_started',$5,$6,$7,$8) RETURNING *`,
      [id, asset.id, asset.yard, pm.name, todayIso(), asset.meter, pm.id, req.user.id]
    );
    if (pm.trigger === "meter") await client.query("UPDATE pm_schedules SET last_done_meter = $2 WHERE id = $1", [pm.id, asset.meter]);
    else await client.query("UPDATE pm_schedules SET last_done_date = $2 WHERE id = $1", [pm.id, todayIso()]);
    await logAudit(client, { userId: req.user.id, action: "work_order.create", entity: "work_order", entityId: id, details: { fromPm: pm.id, asset: asset.id } });
    await client.query("COMMIT");
    const { rows: pm2 } = await query("SELECT * FROM pm_schedules WHERE id = $1", [pm.id]);
    res.status(201).json({ workOrder: w[0], pm: pm2[0] });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

// ---------- Work orders ----------
const WO_SELECT = `SELECT w.*, u.name AS assignee_name, cb.name AS completed_by_name
                   FROM work_orders w LEFT JOIN users u ON u.id = w.assignee_id LEFT JOIN users cb ON cb.id = w.completed_by`;

router.get("/work-orders", requireAuth, async (req, res) => {
  const { yard, status, assigneeId, limit } = req.query;
  const clauses = []; const params = [];
  if (yard) { params.push(yard); clauses.push(`w.yard = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`w.status = $${params.length}`); }
  if (assigneeId) { params.push(assigneeId); clauses.push(`w.assignee_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 500, 2000));
  // Keep the data-URL invoice out of the list (it can be big); fetch one WO for it.
  const { rows } = await query(
    `${WO_SELECT.replace("w.*", "w.id, w.asset_id, w.yard, w.title, w.priority, w.status, w.assignee_id, w.issued_date, w.status_changed_at, w.meter_at_issue, w.from_pm_id, w.from_inspection_id, w.items, w.shop_name, w.invoice_amount, w.invoice_file_name, (w.invoice_data_url IS NOT NULL) AS has_invoice_file, w.completed_at, w.completed_by, w.notes, w.created_by, w.created_at")}
     ${where} ORDER BY w.issued_date DESC, w.created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

router.get("/work-orders/:id", requireAuth, async (req, res) => {
  const { rows } = await query(`${WO_SELECT} WHERE w.id = $1`, [req.params.id]);
  if (!rows.length) return fail(res, 404, "Not found");
  res.json(rows[0]);
});

router.post("/work-orders", requireAuth, async (req, res) => {
  const { assetId, title, priority, assigneeId, items, fromInspectionId, notes } = req.body || {};
  if (!assetId || !title || !title.trim()) return fail(res, 400, "assetId and title are required");
  const pr = priority === undefined ? 3 : parseInt(priority, 10);
  if (!(pr >= 1 && pr <= 5)) return fail(res, 400, "priority must be 1–5");
  if (fromInspectionId && !userCan(req.user, "assignWorkOrderItems")) return fail(res, 403, "Missing permission: assignWorkOrderItems");
  if (items !== undefined && !Array.isArray(items)) return fail(res, 400, "items must be a list");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: a } = await client.query("SELECT * FROM assets WHERE id = $1", [assetId]);
    if (!a.length) { await client.query("ROLLBACK"); return fail(res, 400, "assetId does not match any asset"); }
    if (assigneeId) {
      const { rows: u } = await client.query("SELECT id FROM users WHERE id = $1 AND active = true", [assigneeId]);
      if (!u.length) { await client.query("ROLLBACK"); return fail(res, 400, "assigneeId does not match an active user"); }
    }
    const asset = a[0];
    const id = await nextWorkOrderId(client, asset);
    const { rows: w } = await client.query(
      `INSERT INTO work_orders (id, asset_id, yard, title, priority, status, assignee_id, issued_date, meter_at_issue, from_inspection_id, items, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, asset.id, asset.yard, title.trim(), pr, assigneeId ? "not_started" : "unassigned", assigneeId || null, todayIso(), asset.meter,
       fromInspectionId || null, items !== undefined ? JSON.stringify(items) : null, notes || null, req.user.id]
    );
    if (assigneeId) await notifyAssignment(client, w[0], asset, assigneeId);
    await logAudit(client, { userId: req.user.id, action: "work_order.create", entity: "work_order", entityId: id, details: { asset: asset.id, assigneeId: assigneeId || null, fromInspectionId: fromInspectionId || null } });
    await client.query("COMMIT");
    const { rows } = await query(`${WO_SELECT} WHERE w.id = $1`, [id]);
    res.status(201).json(rows[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

// Status moves, reassignment, priority/title edits, and the shop invoice all go through here.
router.patch("/work-orders/:id", requireAuth, async (req, res) => {
  const { status, assigneeId, priority, title, notes, shopName, invoiceAmount, invoiceFileName, invoiceDataUrl } = req.body || {};
  if (status !== undefined && !WO_STATUSES.includes(status)) return fail(res, 400, `status must be one of ${WO_STATUSES.join(", ")}`);
  if (priority !== undefined && !(priority >= 1 && priority <= 5)) return fail(res, 400, "priority must be 1–5");
  if (invoiceDataUrl && invoiceDataUrl.length > MAX_INVOICE_BYTES * 1.37) return fail(res, 413, "Invoice file is too large (4 MB max) — take a smaller photo or a PDF");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cur } = await client.query("SELECT * FROM work_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!cur.length) { await client.query("ROLLBACK"); return fail(res, 404, "Not found"); }
    const wo = cur[0];
    let newAssignee = wo.assignee_id;
    if (assigneeId !== undefined) {
      if (assigneeId) {
        const { rows: u } = await client.query("SELECT id FROM users WHERE id = $1 AND active = true", [assigneeId]);
        if (!u.length) { await client.query("ROLLBACK"); return fail(res, 400, "assigneeId does not match an active user"); }
      }
      newAssignee = assigneeId || null;
    }
    let newStatus = status !== undefined ? status : wo.status;
    // Assigning an unassigned WO moves it to not_started, as the board does.
    if (newAssignee && newStatus === "unassigned") newStatus = "not_started";
    const statusChanged = newStatus !== wo.status;
    const clearInvoice = invoiceDataUrl === null && invoiceFileName === null;
    await client.query(
      `UPDATE work_orders SET
         status = $2, status_changed_at = CASE WHEN $3 THEN now() ELSE status_changed_at END,
         assignee_id = $4, priority = COALESCE($5, priority), title = COALESCE($6, title), notes = COALESCE($7, notes),
         shop_name = CASE WHEN $8 THEN NULL ELSE COALESCE($9, shop_name) END,
         invoice_amount = CASE WHEN $8 THEN NULL ELSE COALESCE($10, invoice_amount) END,
         invoice_file_name = CASE WHEN $8 THEN NULL ELSE COALESCE($11, invoice_file_name) END,
         invoice_data_url = CASE WHEN $8 THEN NULL ELSE COALESCE($12, invoice_data_url) END,
         completed_at = CASE WHEN $2 = 'complete' AND completed_at IS NULL THEN now() WHEN $2 <> 'complete' THEN NULL ELSE completed_at END,
         completed_by = CASE WHEN $2 = 'complete' AND completed_by IS NULL THEN $13 WHEN $2 <> 'complete' THEN NULL ELSE completed_by END
       WHERE id = $1`,
      [wo.id, newStatus, statusChanged, newAssignee, priority ?? null, title ?? null, notes ?? null, clearInvoice,
       shopName ?? null, invoiceAmount ?? null, invoiceFileName ?? null, invoiceDataUrl ?? null, req.user.id]
    );
    if (newAssignee && newAssignee !== wo.assignee_id) {
      const { rows: a } = await client.query("SELECT * FROM assets WHERE id = $1", [wo.asset_id]);
      await notifyAssignment(client, wo, a[0], newAssignee);
    }
    await logAudit(client, { userId: req.user.id, action: "work_order.update", entity: "work_order", entityId: wo.id, details: { status: statusChanged ? newStatus : undefined, assigneeId: newAssignee !== wo.assignee_id ? newAssignee : undefined, priority, shopName, invoiceAmount } });
    await client.query("COMMIT");
    const { rows } = await query(`${WO_SELECT} WHERE w.id = $1`, [wo.id]);
    res.json(rows[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

// ---------- Inspections ----------
router.get("/inspections", requireAuth, async (req, res) => {
  const { yard, assetId, limit } = req.query;
  const clauses = []; const params = [];
  if (yard) { params.push(yard); clauses.push(`yard = $${params.length}`); }
  if (assetId) { params.push(assetId); clauses.push(`asset_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 300, 2000));
  const { rows } = await query(`SELECT * FROM inspections ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`, params);
  res.json(rows);
});

router.post("/inspections", requireAuth, async (req, res) => {
  const { assetId, meterValue, completedBy, results, service, type, date } = req.body || {};
  if (!assetId) return fail(res, 400, "assetId is required");
  if (!Array.isArray(results) || !results.length) return fail(res, 400, "results must be a non-empty list of { category, item, pass, note }");
  for (const r of results) if (!r || typeof r.item !== "string" || typeof r.pass !== "boolean") return fail(res, 400, "each result needs item (text) and pass (true/false)");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: a } = await client.query("SELECT * FROM assets WHERE id = $1 FOR UPDATE", [assetId]);
    if (!a.length) { await client.query("ROLLBACK"); return fail(res, 400, "assetId does not match any asset"); }
    const asset = a[0];
    const { rows: seq } = await client.query("SELECT nextval('inspection_seq') AS n");
    const id = `INS-${seq[0].n}`;
    const score = Math.round((results.filter((r) => r.pass).length / results.length) * 1000) / 10;
    const meter = meterValue !== undefined && meterValue !== null && meterValue !== "" ? parseFloat(meterValue) : parseFloat(asset.meter);
    const { rows: ins } = await client.query(
      `INSERT INTO inspections (id, asset_id, yard, date, meter_value, service, type, completed_by, completed_by_user_id, results, score)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'Daily'),COALESCE($7,'Pre-Shift'),$8,$9,$10,$11) RETURNING *`,
      [id, asset.id, asset.yard, date || todayIso(), meter, service, type, completedBy || req.user.name, req.user.id, JSON.stringify(results), score]
    );
    if (meter >= parseFloat(asset.meter)) await client.query("UPDATE assets SET meter = $2 WHERE id = $1", [asset.id, meter]);
    await logAudit(client, { userId: req.user.id, action: "inspection.create", entity: "inspection", entityId: id, details: { asset: asset.id, score, failed: results.filter((r) => !r.pass).length } });
    await client.query("COMMIT");
    res.status(201).json(ins[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

module.exports = router;
