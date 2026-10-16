const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const fieldCrypto = require("../fieldCrypto");
const { buildFile, buildXlsx, XLSX_MIME, normalizeConfig, isoDay, DEFAULT_CONFIG, FIELDS, FORMATS, DATE_FORMATS, AMOUNT_FORMATS } = require("../positivePayFormat");

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Positive Pay: tell the bank which checks we issued (and which we voided) so it refuses the rest.
//
//   GET  /positive-pay/pending?account=SB|ALL   checks not yet reported — issues and voids
//   POST /positive-pay/batches { account }      build the file for everything pending, log it, return it
//   GET  /positive-pay/batches?account=SB|ALL   history (ALL = every batch, per-yard and combined)
//   GET  /positive-pay/batches/:id/file         re-download the exact file that was built
//   GET  /positive-pay/preview?account=         the file as it WOULD be built (nothing recorded)
//   GET  /positive-pay/options                  field names / formats for the settings UI
//
// account=ALL builds one file covering every yard's account — the way the ScrapDragon check
// register export did — using the layout of the first account that has one configured.
//
// What counts as pending:
//   issue — a non-voided Check remittance with a check number, not yet reported as an issue.
//           (Checks voided before they were ever reported are skipped: the bank never saw them.)
//   void  — a voided remittance whose issue WAS reported, with no void reported yet.
// Building a file needs payRemittances. Each check is reported as an issue once and a void once,
// whether it went out in a per-yard file or a combined one (the unique index on items enforces it).
// ---------------------------------------------------------------------------------------------

const ALL = "ALL";
const PENDING_SQL = `
  SELECT r.id AS remittance_id, r.account, r.check_number, r.total AS amount, r.payee, r.date AS issue_date, r.voided,
         CASE WHEN r.voided THEN 'void' ELSE 'issue' END AS kind
  FROM remittances r
  WHERE ($1::text IS NULL OR r.account = $1) AND r.method = 'Check' AND r.check_number IS NOT NULL AND r.check_number <> ''
    AND (
      (r.voided = false AND NOT EXISTS (SELECT 1 FROM positive_pay_items i WHERE i.remittance_id = r.id AND i.kind = 'issue'))
      OR
      (r.voided = true AND EXISTS (SELECT 1 FROM positive_pay_items i WHERE i.remittance_id = r.id AND i.kind = 'issue')
                       AND NOT EXISTS (SELECT 1 FROM positive_pay_items i WHERE i.remittance_id = r.id AND i.kind = 'void'))
    )
  ORDER BY r.account, r.date, r.check_number::text`;

function rowToAccount(a) {
  return {
    yard: a.yard, bankName: a.bank_name, last4: a.last4, enabled: a.positive_pay_enabled,
    accountNumber: fieldCrypto.decrypt(a.account_number_enc), routingNumber: a.routing_number,
    config: normalizeConfig(a.positive_pay_config).config, hasConfig: !!a.positive_pay_config,
  };
}
// Returns { scope, config, accounts: { yard -> account } }
async function loadScope(client, scope) {
  const { rows } = await client.query("SELECT * FROM bank_accounts ORDER BY yard");
  const accounts = {}; rows.forEach(a => { accounts[a.yard] = rowToAccount(a); });
  if (scope === ALL) {
    const layoutFrom = Object.values(accounts).find(a => a.hasConfig) || Object.values(accounts)[0];
    if (!layoutFrom) throw Object.assign(new Error("No bank accounts set up"), { status: 404 });
    return { scope: ALL, config: layoutFrom.config, layoutYard: layoutFrom.yard, accounts, enabled: Object.values(accounts).some(a => a.enabled), bankName: layoutFrom.bankName };
  }
  const a = accounts[scope];
  if (!a) throw Object.assign(new Error("No bank account for that yard"), { status: 404 });
  return { scope, config: a.config, layoutYard: a.yard, accounts, enabled: a.enabled, bankName: a.bankName, last4: a.last4 };
}
function toItem(r) { return { remittanceId: r.remittance_id, account: r.account, kind: r.kind, checkNumber: r.check_number, amount: parseFloat(r.amount), payee: r.payee, issueDate: isoDay(r.issue_date) }; }
// Only the fields the layout actually uses have to be on file.
function readiness(sc, items) {
  const problems = [], uses = (f) => sc.config.fields.some(x => x.field === f);
  const yards = sc.scope === ALL ? [...new Set((items || []).map(i => i.account))] : [sc.scope];
  for (const y of yards) {
    const a = sc.accounts[y]; if (!a) continue;
    if (uses("account") && !a.accountNumber) problems.push(fieldCrypto.configured() ? `${y}: account number not entered (Settings → Bank Accounts)` : "ID_ENCRYPTION_KEY is not set on the server, so account numbers can't be stored");
    if (uses("routing") && !a.routingNumber) problems.push(`${y}: routing number not entered`);
  }
  return [...new Set(problems)];
}
const EXT = { xlsx: "xlsx", csv: "csv", fixed: "txt" };
function filename(sc, when = new Date()) {
  const ts = when.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `positive-pay_${sc.scope === ALL ? "all-yards" : sc.scope}_${ts}.${EXT[sc.config.format] || "txt"}`;
}
// For a combined file each row carries its own account's number; per-yard files use that account.
function acctFor(sc, item) { return sc.accounts[item.account] || { accountNumber: "", routingNumber: "", bankName: sc.bankName }; }
// Each row carries its own account so account/routing columns are right in a combined file.
function tagged(sc, items) { return items.map(it => ({ ...it, acct: acctFor(sc, it) })); }
function renderText(sc, items) { return buildFile(tagged(sc, items), acctFor(sc, items[0] || {}), sc.config); }
function renderXlsx(sc, items) { return buildXlsx(tagged(sc, items), acctFor(sc, items[0] || {}), sc.config); }
async function listPending(client, scope) {
  const { rows } = await client.query(PENDING_SQL, [scope === ALL ? null : scope]);
  return rows.map(toItem);
}

router.get("/options", requireAuth, (req, res) => res.json({ fields: FIELDS, formats: FORMATS, dateFormats: DATE_FORMATS, amountFormats: AMOUNT_FORMATS, defaultConfig: DEFAULT_CONFIG }));

router.get("/pending", requireAuth, async (req, res) => {
  const scope = req.query.account; if (!scope) return res.status(400).json({ error: "account is required (yard code or ALL)" });
  const client = await pool.connect();
  try {
    const sc = await loadScope(client, scope);
    const items = await listPending(client, scope);
    const last = await client.query(`SELECT created_at FROM positive_pay_batches WHERE ${scope === ALL ? "TRUE" : "(account = $1 OR account IS NULL)"} ORDER BY created_at DESC LIMIT 1`, scope === ALL ? [] : [scope]);
    res.json({
      account: scope, enabled: sc.enabled, layoutYard: sc.layoutYard, format: sc.config.format, problems: readiness(sc, items), lastSentAt: last.rows[0]?.created_at || null,
      items, issueCount: items.filter(i => i.kind === "issue").length, voidCount: items.filter(i => i.kind === "void").length,
      issueTotal: items.filter(i => i.kind === "issue").reduce((s, i) => s + i.amount, 0),
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  finally { client.release(); }
});

router.get("/preview", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const scope = req.query.account; if (!scope) return res.status(400).json({ error: "account is required" });
  const client = await pool.connect();
  try {
    const sc = await loadScope(client, scope);
    let items = await listPending(client, scope);
    const sample = !items.length;
    const y = sc.layoutYard, today = isoDay(new Date());
    if (sample) items = [{ account: y, kind: "issue", checkNumber: "1001", amount: 1234.56, payee: "Sample Payee", issueDate: today }, { account: y, kind: "void", checkNumber: "1002", amount: 50, payee: "Sample Void", issueDate: today }];
    // Preview never needs real account numbers; mask them.
    const masked = { ...sc, accounts: Object.fromEntries(Object.entries(sc.accounts).map(([k, a]) => [k, { ...a, accountNumber: a.accountNumber ? "••••" + a.last4 : "" }])) };
    res.json({ filename: filename(sc), format: sc.config.format, content: renderText(masked, items), sample, problems: readiness(sc, items) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  finally { client.release(); }
});

router.post("/batches", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const scope = (req.body || {}).account; if (!scope) return res.status(400).json({ error: "account is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sc = await loadScope(client, scope);
    const { rows } = await client.query(PENDING_SQL + " FOR UPDATE OF r", [scope === ALL ? null : scope]);
    if (!rows.length) throw Object.assign(new Error("Nothing to report — every check has already been sent."), { status: 409 });
    const items = rows.map(toItem).filter(i => i.kind === "issue" || sc.config.includeVoids);
    const problems = readiness(sc, items);
    if (problems.length) throw Object.assign(new Error(problems.join(". ")), { status: 409 });
    const content = renderText(sc, items);
    const name = filename(sc);
    const issues = items.filter(i => i.kind === "issue");
    const { rows: b } = await client.query(
      `INSERT INTO positive_pay_batches (account, filename, format, item_count, issue_count, void_count, total, content, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, account, filename, format, item_count, issue_count, void_count, total, created_at`,
      [scope === ALL ? null : scope, name, sc.config.format, items.length, issues.length, items.length - issues.length, issues.reduce((s, i) => s + i.amount, 0), content, req.user.id]
    );
    for (const it of items) {
      await client.query(
        "INSERT INTO positive_pay_items (batch_id, remittance_id, kind, check_number, amount, payee, issue_date) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [b[0].id, it.remittanceId, it.kind, it.checkNumber, it.amount, it.payee, it.issueDate]
      );
    }
    await client.query("INSERT INTO audit_log (entity, entity_id, action, user_id, details) VALUES ('positive_pay', $1, 'positive_pay.build', $2, $3)",
      [b[0].id, req.user.id, JSON.stringify({ account: scope, filename: name, issues: issues.length, voids: items.length - issues.length })]);
    await client.query("COMMIT");
    const out = { batch: b[0], content, mime: "text/plain" };
    if (sc.config.format === "xlsx") { out.mime = XLSX_MIME; out.contentBase64 = renderXlsx(sc, items).toString("base64"); }
    res.status(201).json(out);
  } catch (err) { await client.query("ROLLBACK"); res.status(err.status || 500).json({ error: err.message }); }
  finally { client.release(); }
});

router.get("/batches", requireAuth, async (req, res) => {
  const scope = req.query.account;
  const where = !scope || scope === ALL ? "" : "WHERE (b.account = $1 OR b.account IS NULL)";
  const { rows } = await query(
    `SELECT b.id, b.account, b.filename, b.format, b.item_count, b.issue_count, b.void_count, b.total, b.created_at, u.name AS created_by_name
     FROM positive_pay_batches b LEFT JOIN users u ON u.id = b.created_by ${where} ORDER BY b.created_at DESC LIMIT 200`, where ? [scope] : []);
  res.json(rows);
});

// Re-download. Text formats come back exactly as stored; Excel is rebuilt from the batch's own
// items (same rows, same layout) because a workbook isn't text.
router.get("/batches/:id/file", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { rows } = await query("SELECT account, filename, format, content FROM positive_pay_batches WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const b = rows[0];
  res.set("Content-Disposition", `attachment; filename="${b.filename}"`);
  res.set("Cache-Control", "no-store");
  if (b.format === "xlsx") {
    const client = await pool.connect();
    try {
      const sc = await loadScope(client, b.account || ALL);
      const { rows: its } = await client.query(
        `SELECT i.remittance_id, r.account, i.kind, i.check_number, i.amount, i.payee, i.issue_date FROM positive_pay_items i JOIN remittances r ON r.id = i.remittance_id
         WHERE i.batch_id = $1 ORDER BY r.account, i.issue_date, i.check_number`, [req.params.id]);
      res.set("Content-Type", XLSX_MIME);
      return res.send(renderXlsx(sc, its.map(toItem)));
    } finally { client.release(); }
  }
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(b.content);
});

router.get("/batches/:id/items", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT i.remittance_id, r.account, i.kind, i.check_number, i.amount, i.payee, i.issue_date FROM positive_pay_items i JOIN remittances r ON r.id = i.remittance_id WHERE i.batch_id = $1 ORDER BY r.account, i.issue_date, i.check_number", [req.params.id]);
  res.json(rows);
});

module.exports = router;
