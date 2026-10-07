const express = require("express");
const { query } = require("../db");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();

// App-wide settings as one object: { key: value }. Anyone can read (the UI needs targets to draw
// meters); changing one needs manageUsers until a dedicated permission earns its keep.
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT key, value, updated_at FROM app_settings ORDER BY key");
  const out = {};
  rows.forEach((r) => { out[r.key] = r.value; });
  res.json(out);
});

router.patch("/", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return res.status(400).json({ error: "Send an object of { key: value }" });
  for (const key of keys) {
    await query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(body[key]), req.user.id]
    );
  }
  const { rows } = await query("SELECT key, value FROM app_settings ORDER BY key");
  const out = {};
  rows.forEach((r) => { out[r.key] = r.value; });
  res.json(out);
});

module.exports = router;
