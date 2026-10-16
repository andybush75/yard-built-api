// Builds a positive-pay file from a list of check records according to a per-bank config.
//
// Every bank's positive-pay import is a little different, so the layout is data, not code:
//   {
//     format:         "csv" | "fixed",
//     delimiter:      ",",                 (csv) field separator — "," "|" ";" or "\t"
//     header:         true,                (csv) emit a header row of field labels
//     quote:          true,                (csv) quote text fields that contain the delimiter / quotes
//     dateFormat:     "MM/DD/YYYY",        MM/DD/YYYY · MMDDYYYY · YYYYMMDD · YYYY-MM-DD · MM/DD/YY · MMDDYY
//     amountFormat:   "decimal",           decimal (1234.56) · cents (123456, zero-padded to width for fixed)
//     issueCode:      "I",  voidCode: "V", values written for the "type" field
//     includeVoids:   true,                voided checks are reported as void records
//     payeeMaxLength: 40,
//     lineEnding:     "\r\n",
//     fields: [ { field, label?, width?, align?, pad?, value? }, ... ]
//   }
// field is one of: account, routing, checkNumber, amount, date, payee, type, bankName, literal, blank.
// For fixed format each field needs width; align is "left"|"right" (default left for text, right
// for amount/checkNumber); pad is the fill char (default " ", or "0" for right-aligned numbers).

const FIELDS = ["account", "routing", "checkNumber", "amount", "date", "payee", "type", "bankName", "literal", "blank"];
const DATE_FORMATS = ["MM/DD/YYYY", "MMDDYYYY", "YYYYMMDD", "YYYY-MM-DD", "MM/DD/YY", "MMDDYY"];
const AMOUNT_FORMATS = ["decimal", "cents"];

const DEFAULT_CONFIG = {
  format: "csv", delimiter: ",", header: true, quote: true, dateFormat: "MM/DD/YYYY", amountFormat: "decimal",
  issueCode: "I", voidCode: "V", includeVoids: true, payeeMaxLength: 40, lineEnding: "\r\n",
  fields: [
    { field: "account", label: "Account Number" },
    { field: "checkNumber", label: "Check Number" },
    { field: "date", label: "Issue Date" },
    { field: "amount", label: "Amount" },
    { field: "payee", label: "Payee" },
    { field: "type", label: "Record Type" },
  ],
};

function normalizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const errors = [];
  if (!["csv", "fixed"].includes(c.format)) errors.push("format must be csv or fixed");
  if (!DATE_FORMATS.includes(c.dateFormat)) errors.push(`dateFormat must be one of ${DATE_FORMATS.join(", ")}`);
  if (!AMOUNT_FORMATS.includes(c.amountFormat)) errors.push("amountFormat must be decimal or cents");
  if (typeof c.delimiter !== "string" || !c.delimiter.length || c.delimiter.length > 2) errors.push("delimiter must be 1–2 characters");
  if (!["\n", "\r\n"].includes(c.lineEnding)) c.lineEnding = "\r\n";
  if (!Array.isArray(c.fields) || !c.fields.length) errors.push("fields must be a non-empty list");
  else c.fields.forEach((f, i) => {
    if (!f || !FIELDS.includes(f.field)) errors.push(`fields[${i}].field must be one of ${FIELDS.join(", ")}`);
    if (c.format === "fixed" && !(Number.isInteger(f.width) && f.width > 0 && f.width <= 200)) errors.push(`fields[${i}].width is required for fixed-width files`);
  });
  c.payeeMaxLength = Math.min(Math.max(parseInt(c.payeeMaxLength, 10) || 40, 5), 120);
  return { config: c, errors };
}

function isoDay(v) {
  // pg hands DATE columns back as JS Dates (local midnight); strings pass through.
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
}
function fmtDate(iso, fmt) {
  const d = isoDay(iso); const [y, m, dd] = d.split("-");
  switch (fmt) {
    case "MMDDYYYY": return `${m}${dd}${y}`;
    case "YYYYMMDD": return `${y}${m}${dd}`;
    case "YYYY-MM-DD": return d;
    case "MM/DD/YY": return `${m}/${dd}/${y.slice(2)}`;
    case "MMDDYY": return `${m}${dd}${y.slice(2)}`;
    default: return `${m}/${dd}/${y}`;
  }
}
function fmtAmount(n, fmt) {
  const cents = Math.round(Number(n) * 100);
  return fmt === "cents" ? String(cents) : (cents / 100).toFixed(2);
}
function cleanText(s, max) {
  // Banks choke on commas, quotes and odd characters inside payee names in fixed files; keep it plain.
  return String(s || "").replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7E]/g, "").trim().slice(0, max);
}

// item: { kind: 'issue'|'void', checkNumber, amount, payee, issueDate }
// acct: { accountNumber, routingNumber, bankName }
function fieldValue(f, item, acct, c) {
  switch (f.field) {
    case "account": return acct.accountNumber || "";
    case "routing": return acct.routingNumber || "";
    case "checkNumber": return String(item.checkNumber);
    case "amount": return fmtAmount(item.amount, c.amountFormat);
    case "date": return fmtDate(item.issueDate, c.dateFormat);
    case "payee": return cleanText(item.payee, c.payeeMaxLength);
    case "type": return item.kind === "void" ? c.voidCode : c.issueCode;
    case "bankName": return cleanText(acct.bankName, 60);
    case "literal": return String(f.value ?? "");
    default: return "";
  }
}
function fixedCell(val, f) {
  const numeric = ["amount", "checkNumber"].includes(f.field);
  const align = f.align || (numeric ? "right" : "left");
  const pad = f.pad != null ? String(f.pad).slice(0, 1) || " " : (numeric && align === "right" ? "0" : " ");
  let s = String(val).slice(0, f.width);
  return align === "right" ? s.padStart(f.width, pad) : s.padEnd(f.width, pad);
}
function csvCell(val, c) {
  const s = String(val);
  if (!c.quote) return s.split(c.delimiter).join(" ");
  return /["\r\n]/.test(s) || s.includes(c.delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildFile(items, acct, rawConfig) {
  const { config: c, errors } = normalizeConfig(rawConfig);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400 });
  const lines = [];
  if (c.format === "csv" && c.header) lines.push(c.fields.map(f => csvCell(f.label || f.field, c)).join(c.delimiter));
  for (const it of items) {
    if (it.kind === "void" && !c.includeVoids) continue;
    const cells = c.fields.map(f => {
      const v = fieldValue(f, it, acct, c);
      return c.format === "fixed" ? fixedCell(v, f) : csvCell(v, c);
    });
    lines.push(c.format === "fixed" ? cells.join("") : cells.join(c.delimiter));
  }
  return lines.join(c.lineEnding) + c.lineEnding;
}

module.exports = { isoDay, DEFAULT_CONFIG, FIELDS, DATE_FORMATS, AMOUNT_FORMATS, normalizeConfig, buildFile, fmtDate, fmtAmount };
