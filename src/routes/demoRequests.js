const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

// ---------------------------------------------------------------------------------------------
// Demo requests from the public site (www.yardbuilt.net).
//   POST /public/demo-requests   — no auth; honeypot + per-IP rate limit
//   GET  /demo-requests          — manageUsers
//   PATCH /demo-requests/:id     — manageUsers { status, notes }
// ---------------------------------------------------------------------------------------------

const publicRouter = express.Router();
const adminRouter = express.Router();

const hits = new Map(); // ip -> [timestamps]
const WINDOW = 60 * 60 * 1000, MAX_PER_WINDOW = 5;
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW)) hits.delete(k);
  return list.length > MAX_PER_WINDOW;
}
const clip = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) || null);
const STATUSES = ["new", "contacted", "closed"];

publicRouter.post("/demo-requests", async (req, res) => {
  const b = req.body || {};
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (b.website) return res.status(201).json({ ok: true }); // honeypot filled: pretend success, store nothing
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests from this connection. Try again in an hour, or email us." });
  const name = clip(b.name, 120), company = clip(b.company, 160), email = clip(b.email, 200);
  if (!name || !company || !email) return res.status(400).json({ error: "Name, company and email are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "That email address doesn't look complete." });
  await query(
    `INSERT INTO demo_requests (name, company, email, phone, yards, current_software, message, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [name, company, email.toLowerCase(), clip(b.phone, 40), clip(b.yards, 20), clip(b.currentSoftware, 120), clip(b.message, 2000), ip.slice(0, 64), clip(req.headers["user-agent"], 300)]
  );
  res.status(201).json({ ok: true });
});

adminRouter.get("/", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { rows } = await query(
    `SELECT d.id, d.name, d.company, d.email, d.phone, d.yards, d.current_software, d.message, d.status, d.notes, d.created_at, d.updated_at, u.name AS updated_by_name
     FROM demo_requests d LEFT JOIN users u ON u.id = d.updated_by ORDER BY d.created_at DESC LIMIT 500`);
  res.json(rows);
});

adminRouter.patch("/:id", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { status, notes } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
  const { rows } = await query(
    `UPDATE demo_requests SET status = COALESCE($2, status), notes = CASE WHEN $3::boolean THEN $4 ELSE notes END, updated_at = now(), updated_by = $5
     WHERE id = $1 RETURNING id, status, notes`,
    [req.params.id, status ?? null, notes !== undefined, clip(notes, 2000), req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = { publicRouter, adminRouter };
