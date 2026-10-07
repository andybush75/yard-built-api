const express = require("express");
const { pool, query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { unknownKeys } = require("../permissions");
const { managersRemainAfter } = require("../adminGuard");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM roles ORDER BY system DESC, name");
  res.json(rows);
});

router.post("/", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { name, permissions = [] } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const bad = unknownKeys(permissions);
  if (bad.length) return res.status(400).json({ error: `Unknown permission key(s): ${bad.join(", ")}` });
  try {
    const { rows } = await query("INSERT INTO roles (name, system, permissions) VALUES ($1, false, $2) RETURNING *", [name.trim(), permissions]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "A role with that name already exists" });
    throw err;
  }
});

// Built-in (system) roles keep their permission set fixed so "Admin" always means Admin; custom
// roles can be reshaped freely, as long as it doesn't strip the last user-manager of that power.
router.patch("/:id", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { name, permissions } = req.body || {};
  if (permissions !== undefined) {
    const bad = unknownKeys(permissions);
    if (bad.length) return res.status(400).json({ error: `Unknown permission key(s): ${bad.join(", ")}` });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query("SELECT * FROM roles WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!existing.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (existing[0].system && permissions !== undefined) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Built-in roles can't have their permissions changed" });
    }
    if (permissions !== undefined && !(await managersRemainAfter(client, { roles: { [req.params.id]: permissions } }))) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That would leave nobody who can manage users" });
    }
    const { rows } = await client.query(
      "UPDATE roles SET name = COALESCE($2, name), permissions = COALESCE($3, permissions) WHERE id = $1 RETURNING *",
      [req.params.id, name ? name.trim() : null, permissions ?? null]
    );
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "A role with that name already exists" });
    throw err;
  } finally {
    client.release();
  }
});

router.delete("/:id", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const { rows: existing } = await query("SELECT * FROM roles WHERE id = $1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Not found" });
  if (existing[0].system) return res.status(400).json({ error: "Built-in roles can't be deleted" });
  const { rows: assigned } = await query("SELECT count(*)::int AS n FROM users WHERE role_id = $1", [req.params.id]);
  if (assigned[0].n > 0) return res.status(409).json({ error: `Reassign the ${assigned[0].n} user(s) on this role before deleting it` });
  await query("DELETE FROM roles WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
