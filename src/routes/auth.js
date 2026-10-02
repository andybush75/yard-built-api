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
    [email]
  );
  const user = rows[0];
  if (!user || !user.password_hash) return res.status(401).json({ error: "Invalid email or password" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });
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

module.exports = router;
