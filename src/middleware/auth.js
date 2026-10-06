const jwt = require("jsonwebtoken");
const { query } = require("../db");

// No fallback on purpose: a secret written into the code would let anyone who has read this repo
// forge a login token for production. Set JWT_SECRET in .env locally and in Railway's Variables tab.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Refusing to start — see .env.example.");
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "12h" });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role_id, u.grants, u.revokes, r.name AS role_name, r.permissions AS role_permissions
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [payload.sub]
    );
    if (!rows.length) return res.status(401).json({ error: "User no longer exists" });
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Mirrors the prototype's hasPermission(): an explicit grant/revoke on the user wins over
// whatever their role would otherwise allow.
function userCan(user, key) {
  if (!user) return false;
  if (user.grants && user.grants.includes(key)) return true;
  if (user.revokes && user.revokes.includes(key)) return false;
  return !!(user.role_permissions && user.role_permissions.includes(key));
}

function requirePermission(key) {
  return (req, res, next) => {
    if (!userCan(req.user, key)) {
      return res.status(403).json({ error: `Missing permission: ${key}` });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requirePermission, userCan, JWT_SECRET };
