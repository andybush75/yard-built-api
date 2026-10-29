// /jobs — the API behind Settings → Jobs (Yard-Built's Hangfire dashboard).
//   GET    /jobs                      every registered job: schedule, enabled, last run, next run
//   GET    /jobs/runs?name=&limit=    run history, newest first
//   GET    /jobs/runs/:id             one run with its full result / error
//   POST   /jobs/:name/run            queue a run now (body = payload)
//   POST   /jobs/runs/:id/retry       re-queue a run with the same payload
//   PATCH  /jobs/:name                { enabled: true|false } — switch the schedule on or off
//   GET    /jobs/price-sheet-sends    the price-sheet text log (?yard=&vendorId=&limit=)
// Viewing needs a sign-in; running, retrying and switching schedules needs manageUsers.
const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const jobs = require("../jobs");

const router = express.Router();
router.use(requireAuth);

function publicRun(r) {
  return {
    id: Number(r.id), jobName: r.job_name, status: r.status, trigger: r.trigger, triggeredBy: r.triggered_by, triggeredByName: r.triggered_by_name || null,
    retryOf: r.retry_of ? Number(r.retry_of) : null, payload: r.payload, result: r.result, error: r.error,
    queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at,
    durationMs: r.started_at && r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null,
  };
}

router.get("/", async (req, res) => {
  const { rows: last } = await query(
    `SELECT DISTINCT ON (job_name) r.*, u.name AS triggered_by_name FROM job_runs r LEFT JOIN users u ON u.id = r.triggered_by
     ORDER BY job_name, queued_at DESC`
  );
  const { rows: failures } = await query(
    `SELECT job_name, count(*)::int AS n FROM job_runs WHERE status = 'failed' AND queued_at > now() - interval '7 days' GROUP BY job_name`
  );
  const out = [];
  for (const name of jobs.jobNames()) {
    const def = jobs.getJob(name);
    const enabled = await jobs.isEnabled(name);
    const lastRun = last.find((r) => r.job_name === name);
    out.push({
      name, title: def.title, description: def.description, cron: def.cron, tz: jobs.TZ, enabled,
      nextRun: enabled ? jobs.nextRun(name) : null,
      lastRun: lastRun ? publicRun(lastRun) : null,
      failedLast7d: (failures.find((f) => f.job_name === name) || {}).n || 0,
    });
  }
  res.json(out);
});

router.get("/runs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const params = [limit];
  let where = "";
  if (req.query.name) { params.push(req.query.name); where = `WHERE r.job_name = $${params.length}`; }
  const { rows } = await query(
    `SELECT r.*, u.name AS triggered_by_name FROM job_runs r LEFT JOIN users u ON u.id = r.triggered_by ${where}
     ORDER BY r.queued_at DESC LIMIT $1`, params
  );
  res.json(rows.map(publicRun));
});

router.get("/runs/:id", async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, u.name AS triggered_by_name FROM job_runs r LEFT JOIN users u ON u.id = r.triggered_by WHERE r.id = $1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "No such run" });
  res.json(publicRun(rows[0]));
});

router.get("/price-sheet-sends", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const params = [limit]; const where = [];
  if (req.query.yard) { params.push(req.query.yard); where.push(`yard = $${params.length}`); }
  if (req.query.vendorId) { params.push(req.query.vendorId); where.push(`vendor_id = $${params.length}`); }
  if (req.query.runId) { params.push(req.query.runId); where.push(`run_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT id, run_id, vendor_id, vendor_name, phone, yard, tier, channel, status, detail, twilio_sid, body, sent_at
     FROM price_sheet_sends ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sent_at DESC LIMIT $1`, params
  );
  res.json(rows.map((r) => ({ id: Number(r.id), runId: r.run_id ? Number(r.run_id) : null, vendorId: r.vendor_id, vendorName: r.vendor_name, phone: r.phone, yard: r.yard, tier: r.tier,
    channel: r.channel, status: r.status, detail: r.detail, twilioSid: r.twilio_sid, body: r.body, sentAt: r.sent_at })));
});

router.post("/:name/run", requirePermission("manageUsers"), async (req, res) => {
  if (!jobs.getJob(req.params.name)) return res.status(404).json({ error: "No such job" });
  const payload = req.body && Object.keys(req.body).length ? req.body : null;
  const run = await jobs.enqueue(req.params.name, { trigger: "manual", triggeredBy: req.user.id, payload });
  res.status(202).json(publicRun(run));
});

router.post("/runs/:id/retry", requirePermission("manageUsers"), async (req, res) => {
  const { rows } = await query("SELECT * FROM job_runs WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "No such run" });
  const prev = rows[0];
  if (!jobs.getJob(prev.job_name)) return res.status(400).json({ error: `Job ${prev.job_name} is no longer registered` });
  const run = await jobs.enqueue(prev.job_name, { trigger: "retry", triggeredBy: req.user.id, payload: prev.payload, retryOf: prev.id });
  res.status(202).json(publicRun(run));
});

router.patch("/:name", requirePermission("manageUsers"), async (req, res) => {
  if (!jobs.getJob(req.params.name)) return res.status(404).json({ error: "No such job" });
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "Send { enabled: true|false }" });
  await jobs.setEnabled(req.params.name, req.body.enabled, req.user.id);
  res.json({ name: req.params.name, enabled: req.body.enabled, nextRun: req.body.enabled ? jobs.nextRun(req.params.name) : null });
});

module.exports = router;
