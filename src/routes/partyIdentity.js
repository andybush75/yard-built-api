const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission, userCan } = require("../middleware/auth");

// Mounted at /vendors/:id/identity  (mergeParams so :id is the vendor id)
const router = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------------------------------
// Seller identification: driver's license / ID details plus a license photo and a thumbprint.
//
//  - The ID number and date of birth are encrypted with AES-256-GCM before they touch the DB.
//    The key is ID_ENCRYPTION_KEY (64 hex chars) in the environment; without it the server will
//    still show what is on file (masked) but refuses to store new numbers.
//  - Anyone signed in can ADD or REPLACE an ID (scale operators capture it at the kiosk).
//  - Seeing the full number, the date of birth, or either image needs the viewIds permission, and
//    every such reveal is written to id_access_log with who and when.
//  - Images are capped at 600 KB each (the UI downsizes to ~1200px JPEG before upload).
// ---------------------------------------------------------------------------------------------

const ID_TYPES = ["dl", "state_id", "passport", "military", "tribal", "other"];
const IMAGE_KINDS = ["id_front", "thumbprint"];
const MAX_IMAGE = 600 * 1024;

const fieldCrypto = require("../fieldCrypto");
const key = () => (fieldCrypto.configured() ? true : null);
const encrypt = (text) => fieldCrypto.encrypt(text, "ID numbers");
const decrypt = (blob) => fieldCrypto.decrypt(blob);
async function log(vendorId, userId, action) {
  await query("INSERT INTO id_access_log (vendor_id, user_id, action) VALUES ($1,$2,$3)", [vendorId, userId, action]);
}
async function vendorExists(id) {
  const { rows } = await query("SELECT id FROM vendors WHERE id = $1", [id]);
  return rows.length > 0;
}

// Masked summary — safe for every signed-in user.
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT v.id_type, v.id_last4, v.id_state, v.id_expires, v.plate, v.plate_state, v.id_updated_at, u.name AS id_updated_by_name,
            (v.id_number_enc IS NOT NULL) AS has_number, (v.dob_enc IS NOT NULL) AS has_dob,
            EXISTS (SELECT 1 FROM party_images i WHERE i.vendor_id = v.id AND i.kind = 'id_front') AS has_id_photo,
            EXISTS (SELECT 1 FROM party_images i WHERE i.vendor_id = v.id AND i.kind = 'thumbprint') AS has_thumbprint
     FROM vendors v LEFT JOIN users u ON u.id = v.id_updated_by WHERE v.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const r = rows[0];
  res.json({
    idType: r.id_type, idLast4: r.id_last4, idState: r.id_state, idExpires: r.id_expires, plate: r.plate, plateState: r.plate_state,
    hasNumber: r.has_number, hasDob: r.has_dob, hasIdPhoto: r.has_id_photo, hasThumbprint: r.has_thumbprint,
    updatedAt: r.id_updated_at, updatedBy: r.id_updated_by_name, canView: userCan(req.user, "viewIds"), encryptionConfigured: !!key(),
  });
});

// Add / replace the ID details. Blank number = leave the stored number alone.
router.put("/", requireAuth, async (req, res) => {
  const { idType, idNumber, idState, idExpires, dob, plate, plateState } = req.body || {};
  if (idType !== undefined && idType !== null && idType !== "" && !ID_TYPES.includes(idType)) return res.status(400).json({ error: `idType must be one of ${ID_TYPES.join(", ")}` });
  if (!(await vendorExists(req.params.id))) return res.status(404).json({ error: "Not found" });
  const sets = ["id_updated_at = now()", "id_updated_by = $2"]; const params = [req.params.id, req.user.id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  try {
    if (idType !== undefined) push("id_type", idType || null);
    if (idNumber !== undefined && String(idNumber).trim() !== "") {
      const num = String(idNumber).replace(/\s+/g, "").toUpperCase();
      push("id_number_enc", encrypt(num));
      push("id_last4", num.slice(-4));
    }
    if (idState !== undefined) push("id_state", idState ? String(idState).trim().toUpperCase().slice(0, 2) : null);
    if (idExpires !== undefined) push("id_expires", idExpires || null);
    if (dob !== undefined) push("dob_enc", dob ? encrypt(String(dob).slice(0, 10)) : null);
    if (plate !== undefined) push("plate", plate ? String(plate).trim().toUpperCase() : null);
    if (plateState !== undefined) push("plate_state", plateState ? String(plateState).trim().toUpperCase().slice(0, 2) : null);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  await query(`UPDATE vendors SET ${sets.join(", ")} WHERE id = $1`, params);
  await log(req.params.id, req.user.id, "update");
  res.json({ ok: true });
});

// Full number + DOB, for people with viewIds only. Logged.
router.post("/reveal", requireAuth, requirePermission("viewIds"), async (req, res) => {
  const { rows } = await query("SELECT id_number_enc, dob_enc FROM vendors WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  await log(req.params.id, req.user.id, "reveal");
  res.json({ idNumber: decrypt(rows[0].id_number_enc), dob: decrypt(rows[0].dob_enc) });
});

// Upload (replace) an image as a data URL. Anyone signed in — this is the kiosk capture path.
router.post("/images/:kind", requireAuth, async (req, res) => {
  const { kind } = req.params;
  if (!IMAGE_KINDS.includes(kind)) return res.status(400).json({ error: "kind must be id_front or thumbprint" });
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String((req.body || {}).dataUrl || ""));
  if (!m) return res.status(400).json({ error: "dataUrl must be a base64 JPEG/PNG/WebP data URL" });
  const bytes = Buffer.from(m[3], "base64");
  if (bytes.length > MAX_IMAGE) return res.status(413).json({ error: `Image is ${Math.round(bytes.length / 1024)} KB — max is ${MAX_IMAGE / 1024} KB. The app should have downsized it; try again.` });
  if (!(await vendorExists(req.params.id))) return res.status(404).json({ error: "Not found" });
  await query(
    `INSERT INTO party_images (vendor_id, kind, mime, bytes, size, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (vendor_id, kind) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, size = EXCLUDED.size, created_at = now(), created_by = EXCLUDED.created_by`,
    [req.params.id, kind, m[1], bytes, bytes.length, req.user.id]
  );
  await query("UPDATE vendors SET id_updated_at = now(), id_updated_by = $2 WHERE id = $1", [req.params.id, req.user.id]);
  await log(req.params.id, req.user.id, `upload_${kind}`);
  res.status(201).json({ ok: true, size: bytes.length });
});

// View an image — viewIds only, logged. Returned as raw bytes so the browser can show it.
router.get("/images/:kind", requireAuth, requirePermission("viewIds"), async (req, res) => {
  const { kind } = req.params;
  if (!IMAGE_KINDS.includes(kind)) return res.status(400).json({ error: "kind must be id_front or thumbprint" });
  const { rows } = await query("SELECT mime, bytes FROM party_images WHERE vendor_id = $1 AND kind = $2", [req.params.id, kind]);
  if (!rows.length) return res.status(404).json({ error: "No image on file" });
  await log(req.params.id, req.user.id, `view_${kind}`);
  res.set("Content-Type", rows[0].mime);
  res.set("Cache-Control", "no-store");
  res.send(rows[0].bytes);
});

router.delete("/images/:kind", requireAuth, requirePermission("viewIds"), async (req, res) => {
  await query("DELETE FROM party_images WHERE vendor_id = $1 AND kind = $2", [req.params.id, req.params.kind]);
  await log(req.params.id, req.user.id, `delete_${req.params.kind}`);
  res.status(204).end();
});

// Wipe everything identifying (admin-only): used for retention clean-up or on request.
router.delete("/", requireAuth, requirePermission("viewIds"), async (req, res) => {
  await query(
    `UPDATE vendors SET id_type = NULL, id_number_enc = NULL, id_last4 = NULL, id_state = NULL, id_expires = NULL, dob_enc = NULL,
                        plate = NULL, plate_state = NULL, id_updated_at = now(), id_updated_by = $2 WHERE id = $1`,
    [req.params.id, req.user.id]
  );
  await query("DELETE FROM party_images WHERE vendor_id = $1", [req.params.id]);
  await log(req.params.id, req.user.id, "delete");
  res.status(204).end();
});

router.get("/log", requireAuth, requirePermission("viewIds"), async (req, res) => {
  const { rows } = await query(
    `SELECT l.action, l.at, u.name AS user_name FROM id_access_log l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.vendor_id = $1 ORDER BY l.at DESC LIMIT 100`,
    [req.params.id]
  );
  res.json(rows);
});

module.exports = router;
