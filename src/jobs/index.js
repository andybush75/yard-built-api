// Background jobs — Yard-Built's equivalent of ScrapDragon's Hangfire.
//
// pg-boss keeps the queue and the cron schedules in Postgres (its own "pgboss" schema), so there is
// no Redis or second service: the same database Railway already runs is the job store. Every job
// in the registry below gets:
//   - a queue, a worker (one at a time per job — the jobs here are not safe to run concurrently with
//     themselves), and a cron schedule that can be switched on/off from Settings → Jobs;
//   - a job_runs row per attempt with status, result or error, so a failure is visible in the UI
//     and can be retried with one click instead of silently not happening.
//
// Adding a job: write a handler module in src/jobs/, add it to REGISTRY, done — the worker,
// schedule, API and Jobs screen all pick it up from the registry.
const PgBoss = require("pg-boss");
const cronParser = require("cron-parser");
const { query } = require("../db");

const SANDBOX = process.env.SANDBOX === "1";
const TZ = process.env.JOBS_TZ || "America/Denver";

const REGISTRY = {
  "price-sheet-send": {
    title: "Dealer price sheets (text)",
    description: "Texts each dealer on the price list their tier's prices for their yard. Weekday mornings, or Run now for one yard / one dealer.",
    cron: "0 6 * * 1-5",           // weekdays 6:00 AM Mountain (the old prototype's "daily 6:00 AM run")
    defaultEnabled: false,          // nothing texts a real dealer until an admin switches it on
    handler: require("./priceSheetSend"),
  },
  "quickbooks-sync": {
    title: "QuickBooks transfer",
    description: "Posts closed tickets and remittances to QuickBooks Online. Skeleton: reports what is waiting, posts nothing until QuickBooks is connected.",
    cron: "0 23 * * *",             // nightly 11:00 PM Mountain
    defaultEnabled: false,
    handler: require("./quickbooksSync"),
  },
};

let boss = null;

function jobNames() { return Object.keys(REGISTRY); }
function getJob(name) { return REGISTRY[name] || null; }

// Enabled flags live in app_settings under key "jobs": { [name]: { enabled } }.
async function readJobSettings() {
  const { rows } = await query("SELECT value FROM app_settings WHERE key = 'jobs'");
  return (rows[0] && rows[0].value) || {};
}
async function isEnabled(name) {
  const s = await readJobSettings();
  const v = s[name] && s[name].enabled;
  return v === undefined ? !!REGISTRY[name].defaultEnabled : !!v;
}
async function setEnabled(name, enabled, userId) {
  const s = await readJobSettings();
  s[name] = { ...(s[name] || {}), enabled: !!enabled };
  await query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('jobs', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(s), userId || null]
  );
  await applySchedule(name);
}

async function applySchedule(name) {
  if (!boss) return;
  const job = REGISTRY[name];
  if (await isEnabled(name)) {
    await boss.schedule(name, job.cron, { trigger: "schedule" }, { tz: TZ, singletonKey: `${name}-schedule` });
  } else {
    await boss.unschedule(name);
  }
}

function nextRun(name) {
  try { return cronParser.parseExpression(REGISTRY[name].cron, { tz: TZ }).next().toDate().toISOString(); }
  catch { return null; }
}

// ---- run log ----
async function createRun({ name, trigger, triggeredBy, payload, retryOf }) {
  const { rows } = await query(
    `INSERT INTO job_runs (job_name, trigger, triggered_by, payload, retry_of) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, trigger, triggeredBy || null, payload ? JSON.stringify(payload) : null, retryOf || null]
  );
  return rows[0];
}

// Queue a run. The job_runs row is written first so the UI shows it as "queued" immediately; the
// worker flips it to running/succeeded/failed.
async function enqueue(name, { trigger = "manual", triggeredBy = null, payload = null, retryOf = null } = {}) {
  if (!REGISTRY[name]) throw new Error(`Unknown job: ${name}`);
  if (!boss) throw new Error("Job runner is not started");
  const run = await createRun({ name, trigger, triggeredBy, payload, retryOf });
  const queueJobId = await boss.send(name, { runId: run.id, trigger, payload }, { retryLimit: 0, expireInSeconds: 60 * 30 });
  await query("UPDATE job_runs SET queue_job_id = $2 WHERE id = $1", [run.id, queueJobId]);
  return { ...run, queue_job_id: queueJobId };
}

// Worker wrapper: one job_runs row per attempt, result/error recorded, nothing rethrown (pg-boss
// retries are off; retries are a deliberate click on the Jobs screen, like Hangfire's Requeue).
function wrap(name) {
  const job = REGISTRY[name];
  return async ([queued]) => {
    const data = queued.data || {};
    let run;
    if (data.runId) {
      const { rows } = await query("UPDATE job_runs SET status = 'running', started_at = now() WHERE id = $1 RETURNING *", [data.runId]);
      run = rows[0];
    } else {
      // Fired by the cron schedule: no row exists yet.
      const { rows } = await query(
        `INSERT INTO job_runs (job_name, trigger, queue_job_id, status, started_at) VALUES ($1,'schedule',$2,'running',now()) RETURNING *`,
        [name, queued.id]
      );
      run = rows[0];
    }
    const ctx = { runId: run.id, trigger: run.trigger, sandbox: SANDBOX, log: (...a) => console.log(`[job ${name} #${run.id}]`, ...a) };
    try {
      const result = (await job.handler(ctx, data.payload || run.payload || {})) || {};
      const status = result.skipped ? "skipped" : "succeeded";
      await query("UPDATE job_runs SET status = $2, result = $3, finished_at = now() WHERE id = $1", [run.id, status, JSON.stringify(result)]);
      ctx.log(status, JSON.stringify(result));
    } catch (err) {
      const text = (err && err.stack) || String(err);
      await query("UPDATE job_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [run.id, text.slice(0, 20000)]);
      console.error(`[job ${name} #${run.id}] FAILED`, err);
    }
  };
}

async function startJobs() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: "pgboss", archiveCompletedAfterSeconds: 60 * 60 * 24, deleteAfterDays: 7 });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  for (const name of jobNames()) {
    await boss.createQueue(name);
    await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 5 }, wrap(name));
    await applySchedule(name);
  }
  // Anything left "running" from a process that died mid-job (deploy restart) is not coming back.
  await query(`UPDATE job_runs SET status = 'failed', error = 'Server restarted before this run finished', finished_at = now()
               WHERE status = 'running' AND started_at < now() - interval '1 hour'`);
  console.log(`jobs: ${jobNames().length} registered (tz ${TZ}${SANDBOX ? ", sandbox: outbound sends are dry-run" : ""})`);
  return boss;
}

async function stopJobs() { if (boss) await boss.stop({ graceful: true, timeout: 10000 }); }

module.exports = { REGISTRY, TZ, jobNames, getJob, isEnabled, setEnabled, nextRun, enqueue, startJobs, stopJobs };
