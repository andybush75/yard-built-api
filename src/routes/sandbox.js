// Sandbox-only endpoints. Mounted always, but every route 404s unless the server runs with
// SANDBOX=1, so production never exposes a "wipe the database" button.
const express = require("express");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { seedDemo, DEMO_LOGIN, COMPANY } = require("../../db/seed-demo");

const SANDBOX = process.env.SANDBOX === "1";
const router = express.Router();

router.use((req, res, next) => (SANDBOX ? next() : res.status(404).json({ error: "Not a sandbox server" })));

// Public: lets the login screen show the demo credentials.
router.get("/", (req, res) => res.json({ sandbox: true, company: COMPANY, login: DEMO_LOGIN }));

// Wipe everything and reload the demo dataset. Admin (manageUsers) only; every signed-in user's
// records are recreated, so existing tokens keep working for the seeded accounts.
router.post("/reset", requireAuth, requirePermission("manageUsers"), async (req, res) => {
  const result = await seedDemo({ reset: true });
  res.json({ ok: true, ...result });
});

module.exports = router;
