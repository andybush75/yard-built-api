const express = require("express");
const bcrypt = require("bcryptjs");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { unknownKeys } = require("../permissions");
const { managersRemainAfter } = require("../adminGuard");

const router = express.Router();

const MIN_PASSWORD = 8;
// Never return password_hash. Any logged-in user can see the directory (names show up as work-order
// assignees, "requested by", etc.); only manageUsers can change anything.
const SELECT_USER = `SELECT u.id, u.name, u.email, u.role_id, u.grants, u.revokes, u.active, u.created_at,
                            r.name AS role_name
                     FROM users u JOIN roles r ON r.id = u.role_id`;

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(`${SELECT_USER} ORDER BY u.active DESC, u.name`);
  res.json(rows);
});

router.post("/", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { name, email, password, roleId, grants = [], revokes = [] } = req.body || {};
  if (!name || !email || !password || !roleId) {
    return res.status(400).json({ error: "name, email, password, and roleId are required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "email doesn't look like an email address" });
  if (String(password).length < MIN_PASSWORD) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
  const bad = [...unknownKeys(grants), ...unknownKeys(revokes)];
  if (bad.length) return res.status(400).json({ error: `Unknown permission key(s): ${bad.join(", ")}` });
  const { rows: roleRows } = await query("SELECT id FROM roles WHERE id = $1", [roleId]);
  if (!roleRows.length) return res.status(400).json({ error: "roleId does not match any role" });

  const hash = await bcrypt.hash(String(password), 10);
  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role_id, grants, revokes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name.trim(), email.trim().toLowerCase(), hash, roleId, grants, revokes]
    );
    const { rows: out } = await query(`${SELECT_USER} WHERE u.id = $1`, [rows[0].id]);
    res.status(201).json(out[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "A user with that email already exists" });
    throw err;
  }
});

// Changing someone's role, individual grants/revokes, active flag, or resetting their password.
// Two rules: you can't change your own access (ask another admin), and no change may leave the
// company with zero active users who can manage users.
router.patch("/:id", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { name, email, roleId, grants, revokes, active, password } = req.body || {};
  const touchesAccess = roleId !== undefined || grants !== undefined || revokes !== undefined || active !== undefined;
  if (touchesAccess && req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't change your own role, access, or active status — ask another admin" });
  }
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "email doesn't look like an email address" });
  if (password !== undefined && String(password).length < MIN_PASSWORD) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
  const bad = [...(grants !== undefined ? unknownKeys(grants) : []), ...(revokes !== undefined ? unknownKeys(revokes) : [])];
  if (bad.length) return res.status(400).json({ error: `Unknown permission key(s): ${bad.join(", ")}` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!existing.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (roleId !== undefined) {
      const { rows: roleRows } = await client.query("SELECT id FROM roles WHERE id = $1", [roleId]);
      if (!roleRows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "roleId does not match any role" }); }
    }
    if (touchesAccess) {
      const pretend = {};
      if (roleId !== undefined) pretend.role_id = roleId;
      if (grants !== undefined) pretend.grants = grants;
      if (revokes !== undefined) pretend.revokes = revokes;
      if (active !== undefined) pretend.active = !!active;
      if (!(await managersRemainAfter(client, { users: { [req.params.id]: pretend } }))) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "That would leave nobody who can manage users" });
      }
    }
    const hash = password !== undefined ? await bcrypt.hash(String(password), 10) : null;
    await client.query(
      `UPDATE users SET
         name = COALESCE($2, name), email = COALESCE($3, email), role_id = COALESCE($4, role_id),
         grants = COALESCE($5, grants), revokes = COALESCE($6, revokes), active = COALESCE($7, active),
         password_hash = COALESCE($8, password_hash)
       WHERE id = $1`,
      [req.params.id, name ? name.trim() : null, email ? email.trim().toLowerCase() : null, roleId ?? null,
       grants ?? null, revokes ?? null, active === undefined ? null : !!active, hash]
    );
    await client.query("COMMIT");
    const { rows: out } = await query(`${SELECT_USER} WHERE u.id = $1`, [req.params.id]);
    res.json(out[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "A user with that email already exists" });
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
