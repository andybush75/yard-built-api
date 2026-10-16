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
const DATE_FORMATS = ["M/D/YYYY", "MM/DD/YYYY", "MMDDYYYY", "YYYYMMDD", "YYYY-MM-DD", "MM/DD/YY", "MMDDYY"];
const AMOUNT_FORMATS = ["decimal", "cents"];

// Default = the check-register layout Langer's bank already accepts (what ScrapDragon exported):
// an Excel sheet named CheckRegister with status / Check # / Paid Date / Pay To The Order Of / Amount.
const DEFAULT_CONFIG = {
  format: "xlsx", sheetName: "CheckRegister", delimiter: ",", header: true, quote: true, dateFormat: "M/D/YYYY", amountFormat: "decimal",
  issueCode: "issued", voidCode: "void", includeVoids: true, payeeMaxLength: 60, lineEnding: "\r\n",
  fields: [
    { field: "type", label: "status" },
    { field: "checkNumber", label: "Check #" },
    { field: "date", label: "Paid Date" },
    { field: "payee", label: "Pay To The Order Of" },
    { field: "amount", label: "Amount" },
  ],
};
const FORMATS = ["xlsx", "csv", "fixed"];

function normalizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const errors = [];
  if (!FORMATS.includes(c.format)) errors.push("format must be xlsx, csv or fixed");
  c.sheetName = String(c.sheetName || "CheckRegister").replace(/[\\/?*\[\]:]/g, "").slice(0, 31) || "CheckRegister";
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
    case "M/D/YYYY": return `${parseInt(m, 10)}/${parseInt(dd, 10)}/${y}`;
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
// item.acct (per-row account, used by combined all-yard files) wins over the file-level acct.
function fieldValue(f, item, acctDefault, c) {
  const acct = item.acct || acctDefault || {};
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
  const textFormat = c.format === "xlsx" ? "csv" : c.format; // the stored/preview text of an Excel file is its CSV twin
  if (textFormat === "csv" && c.header) lines.push(c.fields.map(f => csvCell(f.label || f.field, c)).join(c.delimiter));
  for (const it of items) {
    if (it.kind === "void" && !c.includeVoids) continue;
    const cells = c.fields.map(f => {
      const v = fieldValue(f, it, acct, c);
      return textFormat === "fixed" ? fixedCell(v, f) : csvCell(v, c);
    });
    lines.push(textFormat === "fixed" ? cells.join("") : cells.join(c.delimiter));
  }
  return lines.join(c.lineEnding) + c.lineEnding;
}


// ---------------------------------------------------------------------------------------------
// Excel output without a dependency: an .xlsx is a zip of a few XML parts. We write real number
// and date cells (so the bank's import sees numbers, not text) and a header row.
const zlib = require("zlib");
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) { // files: [{ name, data: Buffer }]  — deflate each entry
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = f.data, comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, end]);
}
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function excelSerial(iso) { const [y, m, d] = isoDay(iso).split("-").map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000); }
const colRef = (i) => { let s = ""; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

// Cell styles: 0 = text, 1 = date (m/d/yyyy), 2 = money (0.00), 3 = bold header
function buildXlsx(items, acct, c) {
  const rows = [];
  if (c.header) rows.push(c.fields.map(f => ({ t: "s", v: f.label || f.field, s: 3 })));
  for (const it of items) {
    if (it.kind === "void" && !c.includeVoids) continue;
    rows.push(c.fields.map(f => {
      if (f.field === "date") return { t: "n", v: excelSerial(it.issueDate), s: 1 };
      if (f.field === "amount") return { t: "n", v: c.amountFormat === "cents" ? Math.round(it.amount * 100) : Math.round(it.amount * 100) / 100, s: c.amountFormat === "cents" ? 0 : 2 };
      if (f.field === "checkNumber" && /^\d{1,15}$/.test(String(it.checkNumber))) return { t: "n", v: Number(it.checkNumber), s: 0 };
      return { t: "s", v: fieldValue(f, it, acct, c), s: 0 };
    }));
  }
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((cell, ci) => {
    const ref = `${colRef(ci)}${ri + 1}`;
    return cell.t === "n" ? `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>` : `<c r="${ref}" s="${cell.s}" t="inlineStr"><is><t>${xmlEsc(cell.v)}</t></is></c>`;
  }).join("") + "</row>").join("");
  const widths = c.fields.map((f, i) => `<col min="${i + 1}" max="${i + 1}" width="${f.field === "payee" ? 32 : f.field === "checkNumber" ? 14 : 12}" customWidth="1"/>`).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(c.sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(types) }, { name: "_rels/.rels", data: Buffer.from(rels) },
    { name: "xl/workbook.xml", data: Buffer.from(workbook) }, { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels) },
    { name: "xl/styles.xml", data: Buffer.from(styles) }, { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]);
}
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

module.exports = { buildXlsx, XLSX_MIME, FORMATS, isoDay, DEFAULT_CONFIG, FIELDS, DATE_FORMATS, AMOUNT_FORMATS, normalizeConfig, buildFile, fmtDate, fmtAmount };
