const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission, userCan } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Documents: scanned disclosures, BOLs, weight tickets, contracts, insurance, vehicle papers…
//
//   GET    /documents?entityType=&entityId=&category=&yard=&q=&expiringDays=&limit=   (metadata only)
//   GET    /documents/summary                     counts by category + expiring soon (for the tab header)
//   POST   /documents  { title, category, entityType, entityId?, entityLabel?, yard?, notes?, docDate?, expiresOn?, filename, dataUrl }
//   GET    /documents/:id/file                    the bytes (inline or ?download=1)
//   PATCH  /documents/:id                         metadata (uploader or manageDocuments)
//   DELETE /documents/:id                         soft delete (uploader within 24h, or manageDocuments)
//
// Anyone signed in can upload and view — these are business papers, not the encrypted seller IDs.
// Files are capped at 10 MB; the server's JSON limit for this route is raised to carry base64.
// ---------------------------------------------------------------------------------------------

const CATEGORIES = ["disclosure", "id_scan", "bol", "weight_ticket", "contract", "price_agreement", "insurance", "vehicle", "invoice", "permit", "photo", "other"];
const ENTITY_TYPES = ["ticket", "vendor", "customer", "contract", "po", "trailer", "company"];
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^(application\/pdf|image\/(jpeg|png|webp|gif|heic|heif|tiff)|text\/(plain|csv)|application\/(vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|msword|vnd\.ms-excel))$/;

const META_COLS = `d.id, d.title, d.category, d.entity_type, d.entity_id, d.entity_label, d.yard, d.filename, d.mime, d.size, d.notes, d.doc_date, d.expires_on,
                   d.uploaded_by, u.name AS uploaded_by_name, d.created_at`;

function isoDate(v) { if (!v) return null; const s = String(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
function cleanTitle(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 140); }

router.get("/", requireAuth, async (req, res) => {
  const { entityType, entityId, category, yard, q, expiringDays, limit } = req.query;
  const where = ["d.deleted_at IS NULL"]; const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace("?", `$${params.length}`)); };
  if (entityType) add("d.entity_type = ?", entityType);
  if (entityId) add("d.entity_id = ?", entityId);
  if (category) add("d.category = ?", category);
  if (yard) add("d.yard = ?", yard);
  if (q) add("(d.title ILIKE ? OR d.filename ILIKE ? OR d.entity_label ILIKE ? OR d.notes ILIKE ?)".replace(/\?/g, () => `$${params.length + 1}`), `%${String(q).trim()}%`);
  if (expiringDays !== undefined) { const n = Math.max(0, parseInt(expiringDays, 10) || 0); add(`d.expires_on IS NOT NULL AND d.expires_on <= CURRENT_DATE + ?::int`, n); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const { rows } = await query(
    `SELECT ${META_COLS} FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE ${where.join(" AND ")}
     ORDER BY ${expiringDays !== undefined ? "d.expires_on ASC," : ""} d.created_at DESC LIMIT ${lim}`, params);
  res.json(rows);
});

router.get("/summary", requireAuth, async (req, res) => {
  const [{ rows: byCat }, { rows: exp }, { rows: tot }] = await Promise.all([
    query("SELECT category, COUNT(*)::int AS n FROM documents WHERE deleted_at IS NULL GROUP BY category"),
    query("SELECT COUNT(*) FILTER (WHERE expires_on < CURRENT_DATE)::int AS expired, COUNT(*) FILTER (WHERE expires_on >= CURRENT_DATE AND expires_on <= CURRENT_DATE + 60)::int AS soon FROM documents WHERE deleted_at IS NULL AND expires_on IS NOT NULL"),
    query("SELECT COUNT(*)::int AS n, COALESCE(SUM(size),0)::bigint AS bytes FROM documents WHERE deleted_at IS NULL"),
  ]);
  res.json({ byCategory: Object.fromEntries(byCat.map(r => [r.category, r.n])), expired: exp[0].expired, expiringSoon: exp[0].soon, total: tot[0].n, bytes: Number(tot[0].bytes), categories: CATEGORIES, entityTypes: ENTITY_TYPES, maxBytes: MAX_BYTES });
});

router.post("/", requireAuth, async (req, res) => {
  const b = req.body || {};
  const title = cleanTitle(b.title);
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: `category must be one of ${CATEGORIES.join(", ")}` });
  if (!ENTITY_TYPES.includes(b.entityType)) return res.status(400).json({ error: `entityType must be one of ${ENTITY_TYPES.join(", ")}` });
  if (b.entityType !== "company" && !b.entityId) return res.status(400).json({ error: "entityId is required unless entityType is company" });
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(String(b.dataUrl || ""));
  if (!m) return res.status(400).json({ error: "dataUrl must be a base64 data URL" });
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.test(mime)) return res.status(415).json({ error: `File type ${mime} isn't accepted — use PDF, an image, CSV/text, Word or Excel.` });
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length) return res.status(400).json({ error: "The file is empty" });
  if (bytes.length > MAX_BYTES) return res.status(413).json({ error: `File is ${(bytes.length / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB.` });
  const filename = String(b.filename || title).replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 200) || "document";
  const { rows } = await query(
    `INSERT INTO documents (title, category, entity_type, entity_id, entity_label, yard, filename, mime, size, bytes, notes, doc_date, expires_on, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, CURRENT_DATE),$13,$14) RETURNING id`,
    [title, b.category, b.entityType, b.entityType === "company" ? null : String(b.entityId), b.entityLabel ? String(b.entityLabel).slice(0, 140) : null,
     b.yard ? String(b.yard).slice(0, 10) : null, filename, mime, bytes.length, bytes, b.notes ? String(b.notes).slice(0, 2000) : null, isoDate(b.docDate), isoDate(b.expiresOn), req.user.id]
  );
  const { rows: out } = await query(`SELECT ${META_COLS} FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = $1`, [rows[0].id]);
  res.status(201).json(out[0]);
});

router.get("/:id/file", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT filename, mime, bytes FROM documents WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const d = rows[0];
  res.set("Content-Type", d.mime);
  res.set("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${encodeURIComponent(d.filename)}"`);
  res.set("Cache-Control", "private, max-age=300");
  res.send(d.bytes);
});

async function canEdit(req, doc) {
  if (userCan(req.user, "manageDocuments")) return true;
  return doc.uploaded_by === req.user.id;
}

router.patch("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT id, uploaded_by, created_at FROM documents WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  if (!(await canEdit(req, rows[0]))) return res.status(403).json({ error: "Only the person who uploaded this, or someone with Manage documents, can change it." });
  const b = req.body || {}; const sets = []; const params = [req.params.id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.title !== undefined) { const t = cleanTitle(b.title); if (!t) return res.status(400).json({ error: "title can't be blank" }); push("title", t); }
  if (b.category !== undefined) { if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "bad category" }); push("category", b.category); }
  if (b.notes !== undefined) push("notes", b.notes ? String(b.notes).slice(0, 2000) : null);
  if (b.docDate !== undefined) push("doc_date", isoDate(b.docDate));
  if (b.expiresOn !== undefined) push("expires_on", isoDate(b.expiresOn));
  if (b.yard !== undefined) push("yard", b.yard || null);
  if (b.entityType !== undefined) {
    if (!ENTITY_TYPES.includes(b.entityType)) return res.status(400).json({ error: "bad entityType" });
    push("entity_type", b.entityType); push("entity_id", b.entityType === "company" ? null : (b.entityId ? String(b.entityId) : null)); push("entity_label", b.entityLabel ? String(b.entityLabel).slice(0, 140) : null);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
  await query(`UPDATE documents SET ${sets.join(", ")} WHERE id = $1`, params);
  const { rows: out } = await query(`SELECT ${META_COLS} FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = $1`, [req.params.id]);
  res.json(out[0]);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT id, uploaded_by, created_at FROM documents WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const own = rows[0].uploaded_by === req.user.id && Date.now() - new Date(rows[0].created_at).getTime() < 24 * 3600 * 1000;
  if (!own && !userCan(req.user, "manageDocuments")) return res.status(403).json({ error: "Deleting documents needs the Manage documents permission (you can remove your own uploads for 24 hours)." });
  await query("UPDATE documents SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [req.params.id, req.user.id]);
  res.status(204).end();
});

module.exports = { router, CATEGORIES, ENTITY_TYPES };
