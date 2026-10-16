const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  const { rows } = await query(
    `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions FROM users u
     JOIN roles r ON r.id = u.role_id WHERE u.email = $1`,
    [String(email).trim().toLowerCase()]
  );
  const user = rows[0];
  if (!user || !user.password_hash) return res.status(401).json({ error: "Invalid email or password" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });
  if (user.active === false) return res.status(401).json({ error: "This account has been deactivated" });
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  const token = signToken(user);
  res.json({ token, user: publicProfile(user) });
});

function publicProfile(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role_name, permissions: u.role_permissions,
    grants: u.grants, revokes: u.revokes,
    title: u.title || null, phone: u.phone || null, homeYard: u.home_yard || null, yards: u.yards || [],
    mustChangePassword: !!u.must_change_password, lastLoginAt: u.last_login_at || null,
  };
}

const PROFILE_SELECT = `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions
                        FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`;

// A person's own profile: name, phone, home yard. Role, email, yard access and active status are
// admin-only (PATCH /users/:id) so nobody can widen their own access.
router.patch("/me", requireAuth, async (req, res) => {
  const { name, phone, homeYard } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: "name can't be blank" });
  if (homeYard !== undefined && homeYard !== null && homeYard !== "") {
    if (!["SB", "HAYS", "COLBY", "RC"].includes(homeYard)) return res.status(400).json({ error: "Unknown yard" });
    const allowed = req.user.yards || [];
    if (allowed.length && !allowed.includes(homeYard)) return res.status(400).json({ error: "You don't have access to that yard" });
  }
  await query(
    `UPDATE users SET name = COALESCE($2, name),
                      phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                      home_yard = CASE WHEN $5::boolean THEN $6 ELSE home_yard END
     WHERE id = $1`,
    [req.user.id, name ? String(name).trim() : null, phone !== undefined, phone ? String(phone).trim() : null, homeYard !== undefined, homeYard || null]
  );
  const { rows } = await query(PROFILE_SELECT, [req.user.id]);
  res.json(publicProfile(rows[0]));
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await query(PROFILE_SELECT, [req.user.id]);
  res.json(publicProfile(rows[0]));
});

// Anyone can change their own password, but only by proving they know the current one — a token
// left in an unlocked browser shouldn't be enough to take the account over.
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword and newPassword are required" });
  if (String(newPassword).length < 8) return res.status(400).json({ error: "newPassword must be at least 8 characters" });
  const { rows } = await query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  const ok = rows.length && rows[0].password_hash && (await bcrypt.compare(currentPassword, rows[0].password_hash));
  if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
  const hash = await bcrypt.hash(String(newPassword), 10);
  await query("UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1", [req.user.id, hash]);
  res.json({ ok: true });
});

module.exports = router;
