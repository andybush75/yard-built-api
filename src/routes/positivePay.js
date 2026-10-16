const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const fieldCrypto = require("../fieldCrypto");
const { buildFile, normalizeConfig, isoDay, DEFAULT_CONFIG, FIELDS, DATE_FORMATS, AMOUNT_FORMATS } = require("../positivePayFormat");

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Positive Pay: tell the bank which checks we issued (and which we voided) so it refuses the rest.
//
//   GET  /positive-pay/pending?account=SB     checks not yet reported — issues and voids
//   POST /positive-pay/batches { account }    build the file for everything pending, log it, return it
//   GET  /positive-pay/batches?account=SB     history
//   GET  /positive-pay/batches/:id/file       re-download the exact file that was built
//   GET  /positive-pay/preview?account=SB     the file as it WOULD be built (nothing recorded)
//   GET  /positive-pay/options                field names / formats for the settings UI
//
// What counts as pending:
//   issue — a non-voided Check remittance with a check number, drawn on this account, not yet
//           reported as an issue. (Checks voided before they were ever reported are skipped: the
//           bank never saw them, so there is nothing to cancel.)
//   void  — a voided remittance whose issue WAS reported, with no void reported yet.
// Building a file needs payRemittances; the account/routing numbers come from bank_accounts.
// ---------------------------------------------------------------------------------------------

const PENDING_SQL = `
  SELECT r.id AS remittance_id, r.check_number, r.total AS amount, r.payee, r.date AS issue_date, r.voided,
         CASE WHEN r.voided THEN 'void' ELSE 'issue' END AS kind
  FROM remittances r
  WHERE r.account = $1 AND r.method = 'Check' AND r.check_number IS NOT NULL AND r.check_number <> ''
    AND (
      (r.voided = false AND NOT EXISTS (SELECT 1 FROM positive_pay_items i WHERE i.remittance_id = r.id AND i.kind = 'issue'))
      OR
      (r.voided = true AND EXISTS (SELECT 1 FROM positive_pay_items i WHERE i.remittance_id = r.id AND i.kind = 'issue')
                       AND NOT EXISTS (SELECT 1 FROM positive_pay_items i WHERE i.remittance_id = r.id AND i.kind = 'void'))
    )
  ORDER BY r.date, r.check_number::text`;

async function loadAccount(client, yard) {
  const { rows } = await client.query("SELECT * FROM bank_accounts WHERE yard = $1", [yard]);
  if (!rows.length) throw Object.assign(new Error("No bank account for that yard"), { status: 404 });
  const a = rows[0];
  return {
    yard: a.yard, bankName: a.bank_name, last4: a.last4, enabled: a.positive_pay_enabled,
    accountNumber: fieldCrypto.decrypt(a.account_number_enc), routingNumber: a.routing_number,
    config: normalizeConfig(a.positive_pay_config).config,
  };
}
function toItem(r) { return { remittanceId: r.remittance_id, kind: r.kind, checkNumber: r.check_number, amount: parseFloat(r.amount), payee: r.payee, issueDate: isoDay(r.issue_date) }; }
function readiness(acct) {
  const problems = [];
  if (!acct.accountNumber) problems.push(fieldCrypto.configured() ? "Account number not entered (Settings → Bank Accounts)" : "ID_ENCRYPTION_KEY is not set on the server, so the account number can't be stored");
  if (acct.config.fields.some(f => f.field === "routing") && !acct.routingNumber) problems.push("Routing number not entered");
  return problems;
}
function filename(acct, when = new Date()) {
  const ts = when.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `positive-pay_${acct.yard}_${ts}.${acct.config.format === "fixed" ? "txt" : "csv"}`;
}

router.get("/options", requireAuth, (req, res) => res.json({ fields: FIELDS, dateFormats: DATE_FORMATS, amountFormats: AMOUNT_FORMATS, defaultConfig: DEFAULT_CONFIG }));

router.get("/pending", requireAuth, async (req, res) => {
  const yard = req.query.account; if (!yard) return res.status(400).json({ error: "account is required" });
  const client = await pool.connect();
  try {
    const acct = await loadAccount(client, yard);
    const { rows } = await client.query(PENDING_SQL, [yard]);
    const items = rows.map(toItem);
    const last = await client.query("SELECT created_at FROM positive_pay_batches WHERE account = $1 ORDER BY created_at DESC LIMIT 1", [yard]);
    res.json({
      account: yard, enabled: acct.enabled, problems: readiness(acct), lastSentAt: last.rows[0]?.created_at || null,
      items, issueCount: items.filter(i => i.kind === "issue").length, voidCount: items.filter(i => i.kind === "void").length,
      issueTotal: items.filter(i => i.kind === "issue").reduce((s, i) => s + i.amount, 0),
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  finally { client.release(); }
});

router.get("/preview", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const yard = req.query.account; if (!yard) return res.status(400).json({ error: "account is required" });
  const client = await pool.connect();
  try {
    const acct = await loadAccount(client, yard);
    const { rows } = await client.query(PENDING_SQL, [yard]);
    let items = rows.map(toItem);
    // With nothing pending, preview a sample row so the layout can still be checked against the bank's spec.
    const sample = !items.length;
    if (sample) items = [{ kind: "issue", checkNumber: "1001", amount: 1234.56, payee: "Sample Payee", issueDate: new Date().toISOString().slice(0, 10) }, { kind: "void", checkNumber: "1002", amount: 50, payee: "Sample Void", issueDate: new Date().toISOString().slice(0, 10) }];
    const content = buildFile(items, { ...acct, accountNumber: acct.accountNumber || "000000000" }, acct.config);
    res.json({ filename: filename(acct), content, sample, problems: readiness(acct) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  finally { client.release(); }
});

router.post("/batches", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const yard = (req.body || {}).account; if (!yard) return res.status(400).json({ error: "account is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const acct = await loadAccount(client, yard);
    const problems = readiness(acct);
    if (problems.length) throw Object.assign(new Error(problems.join(". ")), { status: 409 });
    const { rows } = await client.query(PENDING_SQL + " FOR UPDATE OF r", [yard]);
    if (!rows.length) throw Object.assign(new Error("Nothing to report — every check on this account has already been sent."), { status: 409 });
    const items = rows.map(toItem).filter(i => i.kind === "issue" || acct.config.includeVoids);
    const content = buildFile(items, acct, acct.config);
    const name = filename(acct);
    const issues = items.filter(i => i.kind === "issue");
    const { rows: b } = await client.query(
      `INSERT INTO positive_pay_batches (account, filename, format, item_count, issue_count, void_count, total, content, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, account, filename, format, item_count, issue_count, void_count, total, created_at`,
      [yard, name, acct.config.format, items.length, issues.length, items.length - issues.length, issues.reduce((s, i) => s + i.amount, 0), content, req.user.id]
    );
    for (const it of items) {
      await client.query(
        "INSERT INTO positive_pay_items (batch_id, remittance_id, kind, check_number, amount, payee, issue_date) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [b[0].id, it.remittanceId, it.kind, it.checkNumber, it.amount, it.payee, it.issueDate]
      );
    }
    await client.query("INSERT INTO audit_log (entity, entity_id, action, user_id, details) VALUES ('positive_pay', $1, 'positive_pay.build', $2, $3)",
      [b[0].id, req.user.id, JSON.stringify({ account: yard, filename: name, issues: issues.length, voids: items.length - issues.length })]);
    await client.query("COMMIT");
    res.status(201).json({ batch: b[0], content });
  } catch (err) { await client.query("ROLLBACK"); res.status(err.status || 500).json({ error: err.message }); }
  finally { client.release(); }
});

router.get("/batches", requireAuth, async (req, res) => {
  const yard = req.query.account;
  const { rows } = await query(
    `SELECT b.id, b.account, b.filename, b.format, b.item_count, b.issue_count, b.void_count, b.total, b.created_at, u.name AS created_by_name
     FROM positive_pay_batches b LEFT JOIN users u ON u.id = b.created_by
     ${yard ? "WHERE b.account = $1" : ""} ORDER BY b.created_at DESC LIMIT 200`, yard ? [yard] : []);
  res.json(rows);
});

router.get("/batches/:id/file", requireAuth, requirePermission("payRemittances"), async (req, res) => {
  const { rows } = await query("SELECT filename, format, content FROM positive_pay_batches WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${rows[0].filename}"`);
  res.set("Cache-Control", "no-store");
  res.send(rows[0].content);
});

router.get("/batches/:id/items", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT remittance_id, kind, check_number, amount, payee, issue_date FROM positive_pay_items WHERE batch_id = $1 ORDER BY issue_date, check_number", [req.params.id]);
  res.json(rows);
});

module.exports = router;
