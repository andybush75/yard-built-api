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
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role_name, permissions: user.role_permissions },
  });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role_name,
    permissions: req.user.role_permissions,
    grants: req.user.grants,
    revokes: req.user.revokes,
  });
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
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.user.id, hash]);
  res.json({ ok: true });
});

module.exports = router;
