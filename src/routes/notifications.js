const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Your own inbox only.
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
    [req.user.id]
  );
  res.json(rows);
});

router.patch("/read-all", requireAuth, async (req, res) => {
  const { rowCount } = await query("UPDATE notifications SET read = true WHERE user_id = $1 AND read = false", [req.user.id]);
  res.json({ marked: rowCount });
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { read } = req.body || {};
  const { rows } = await query(
    "UPDATE notifications SET read = COALESCE($3, read) WHERE id = $1 AND user_id = $2 RETURNING *",
    [req.params.id, req.user.id, read ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = router;
