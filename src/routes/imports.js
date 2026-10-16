const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Bulk import of vendors (dealers) and customers from a ScrapDragon export.
//
// POST /imports/parties  { kind: "vendor" | "customer", rows: [{...}], dryRun?: true }
//   rows are plain objects with any of: name, phone, email, address, notes, tier, terms,
//   businessExempt, externalId. Column names are matched loosely (case/space-insensitive, common
//   ScrapDragon header variants), so the UI can post a parsed CSV/XLSX straight through.
//
// Matching: an existing record with the same normalized phone, or (no phone) the same normalized
// name, is UPDATED (only blank fields are filled in — we never overwrite data someone typed in
// Yard-Built with an export). Everything else is INSERTED. dryRun returns the plan without writing.
// Requires manageUsers (admin) since this touches hundreds of rows at once.
// ---------------------------------------------------------------------------------------------

const ALIASES = {
  name: ["name", "customername", "customer", "vendorname", "vendor", "dealer", "dealername", "company", "companyname", "fullname", "account", "accountname", "custname"],
  phone: ["phone", "phonenumber", "phone1", "primaryphone", "mobile", "cell", "cellphone", "telephone", "tel", "contactphone", "homephone", "workphone"],
  email: ["email", "emailaddress", "e-mail"],
  address: ["address", "address1", "street", "streetaddress", "mailingaddress", "addr"],
  city: ["city"],
  state: ["state", "st"],
  zip: ["zip", "zipcode", "postalcode", "postal"],
  notes: ["notes", "note", "comments", "comment", "memo"],
  tier: ["tier", "pricetier", "pricelevel", "pricingtier", "dealertier", "level"],
  terms: ["terms", "paymentterms", "netterms"],
  businessExempt: ["businessexempt", "business", "commercial", "iscommercial", "type", "customertype", "accounttype"],
  externalId: ["externalid", "id", "customerid", "vendorid", "customernumber", "customer#", "custno", "custid", "number", "accountnumber", "acct#", "acctno"],
  dl: ["dl", "driverslicense", "driverlicense", "license", "idnumber"],
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9#-]/g, "");
const ALIAS_INDEX = {};
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) ALIAS_INDEX[norm(n)] = field;

function mapRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const field = ALIAS_INDEX[norm(k)] || (ALIASES[k] ? k : null);
    if (!field || v == null) continue;
    const val = typeof v === "string" ? v.trim() : v;
    if (val === "") continue;
    if (out[field] === undefined) out[field] = val;
  }
  // Fold city/state/zip into one address line
  const tail = [out.city, [out.state, out.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (tail) out.address = out.address ? `${out.address}, ${tail}` : tail;
  delete out.city; delete out.state; delete out.zip;
  return out;
}

function normPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
}
function fmtPhone(p) {
  const d = normPhone(p);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (String(p || "").trim() || null);
}
const normName = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function parseTier(t) {
  const s = String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!s) return null;
  if (["dh", "dhigh", "dealerhigh", "high", "d3", "4"].includes(s)) return "dh";
  if (["d1", "dealer1", "3"].includes(s)) return "d1";
  if (["d2", "dealer2", "2"].includes(s)) return "d2";
  if (["scale", "retail", "walkin", "public", "1", "0"].includes(s)) return "scale";
  return null;
}
function parseTerms(t) {
  const s = String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!s) return null;
  if (["cod", "due", "dueonreceipt", "net0", "0"].includes(s)) return "cod";
  const m = s.match(/net(\d+)|^(\d+)$/);
  const n = m ? parseInt(m[1] || m[2], 10) : NaN;
  if ([7, 10, 15, 30, 45, 60].includes(n)) return `net${n}`;
  return null;
}
function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase().trim();
  if (["true", "yes", "y", "1", "commercial", "business", "company", "x"].includes(s)) return true;
  if (["false", "no", "n", "0", "public", "individual", "residential", "person"].includes(s)) return false;
  return null;
}

async function loadExisting(client, kind) {
  const { rows } = await client.query(`SELECT id, name, phone, email, notes FROM ${kind === "vendor" ? "vendors" : "customers"}`);
  const byPhone = new Map(), byName = new Map();
  for (const r of rows) {
    const p = normPhone(r.phone); if (p.length >= 7 && !byPhone.has(p)) byPhone.set(p, r);
    const n = normName(r.name); if (n && !byName.has(n)) byName.set(n, r);
  }
  return { rows, byPhone, byName };
}

router.post("/parties", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { kind, rows, dryRun } = req.body || {};
  if (!["vendor", "customer"].includes(kind)) return res.status(400).json({ error: "kind must be vendor or customer" });
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows must be a non-empty list" });
  if (rows.length > 5000) return res.status(400).json({ error: "Import at most 5000 rows per call" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await loadExisting(client, kind);
    const seenPhone = new Set(), seenName = new Set();
    const plan = { kind, dryRun: !!dryRun, insert: 0, update: 0, skipped: 0, duplicatesInFile: 0, unmapped: [], samples: { insert: [], update: [], skipped: [] } };
    const headerSeen = Object.keys(rows[0] || {});
    plan.recognizedColumns = headerSeen.filter((h) => ALIAS_INDEX[norm(h)]);
    plan.ignoredColumns = headerSeen.filter((h) => !ALIAS_INDEX[norm(h)]);

    for (const raw of rows) {
      const r = mapRow(raw);
      if (!r.name) { plan.skipped++; if (plan.samples.skipped.length < 5) plan.samples.skipped.push({ reason: "no name", raw }); continue; }
      if (/^(walk[\s-]*in|cash|misc|unknown)( customer| vendor| sale| purchase)?$/i.test(String(r.name).trim())) { plan.skipped++; if (plan.samples.skipped.length < 5) plan.samples.skipped.push({ reason: "generic walk-in record", raw }); continue; }
      const p = normPhone(r.phone), n = normName(r.name);
      if ((p.length >= 7 && seenPhone.has(p)) || (p.length < 7 && seenName.has(n))) { plan.duplicatesInFile++; continue; }
      if (p.length >= 7) seenPhone.add(p); else seenName.add(n);

      // Vendors have no address column yet, so a dealer's address rides along in notes.
      const notesParts = [r.notes, kind === "vendor" && r.address ? r.address : null, r.externalId ? `SD#${r.externalId}` : null, r.dl ? `DL ${r.dl}` : null].filter(Boolean);
      const fields = {
        name: String(r.name).trim(), phone: fmtPhone(r.phone), email: r.email ? String(r.email).trim().toLowerCase() : null,
        address: r.address || null, notes: notesParts.length ? notesParts.join(" · ") : null,
        tier: parseTier(r.tier), terms: parseTerms(r.terms), businessExempt: parseBool(r.businessExempt),
      };
      const match = (p.length >= 7 && existing.byPhone.get(p)) || existing.byName.get(n) || null;

      if (match) {
        plan.update++;
        if (plan.samples.update.length < 5) plan.samples.update.push({ existing: match.name, incoming: fields.name });
        if (!dryRun) {
          // Fill blanks only. Name is left as the person typed it in Yard-Built.
          if (kind === "vendor") {
            await client.query(
              `UPDATE vendors SET phone = COALESCE(NULLIF(phone,''), $2), email = COALESCE(NULLIF(email,''), $3), notes = COALESCE(NULLIF(notes,''), $4),
                                  tier = CASE WHEN tier = 'scale' AND $5::price_tier IS NOT NULL THEN $5::price_tier ELSE tier END
               WHERE id = $1`,
              [match.id, fields.phone, fields.email, fields.notes, fields.tier]
            );
          } else {
            await client.query(
              `UPDATE customers SET phone = COALESCE(NULLIF(phone,''), $2), email = COALESCE(NULLIF(email,''), $3), notes = COALESCE(NULLIF(notes,''), $4),
                                    address = COALESCE(NULLIF(address,''), $5),
                                    terms = CASE WHEN terms = 'cod' AND $6::payment_terms IS NOT NULL THEN $6::payment_terms ELSE terms END,
                                    business_exempt = CASE WHEN $7::boolean IS NULL THEN business_exempt ELSE $7::boolean END
               WHERE id = $1`,
              [match.id, fields.phone, fields.email, fields.notes, fields.address, fields.terms, fields.businessExempt]
            );
          }
        }
      } else {
        plan.insert++;
        if (plan.samples.insert.length < 5) plan.samples.insert.push(fields);
        if (!dryRun) {
          if (kind === "vendor") {
            const { rows: ins } = await client.query(
              `INSERT INTO vendors (name, phone, email, tier, notes, smartphone, on_price_list)
               VALUES ($1,$2,$3,COALESCE($4::price_tier,'scale'),$5,false,false) RETURNING id, name, phone`,
              [fields.name, fields.phone, fields.email, fields.tier, fields.notes]
            );
            if (p.length >= 7) existing.byPhone.set(p, ins[0]); existing.byName.set(n, ins[0]);
          } else {
            const { rows: ins } = await client.query(
              `INSERT INTO customers (name, phone, email, tier, notes, terms, address, business_exempt)
               VALUES ($1,$2,$3,'scale',$4,COALESCE($5::payment_terms,'cod'),$6,COALESCE($7::boolean,false)) RETURNING id, name, phone`,
              [fields.name, fields.phone, fields.email, fields.notes, fields.terms, fields.address, fields.businessExempt]
            );
            if (p.length >= 7) existing.byPhone.set(p, ins[0]); existing.byName.set(n, ins[0]);
          }
        }
      }
    }
    if (dryRun) await client.query("ROLLBACK"); else await client.query("COMMIT");
    plan.total = rows.length;
    res.json(plan);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
