const crypto = require("crypto");

// AES-256-GCM for individual sensitive columns (ID numbers, dates of birth, bank account numbers).
// Key is ID_ENCRYPTION_KEY — 64 hex chars — set only in the server environment (Railway).
// Blob format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>

function key() {
  const hex = process.env.ID_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}
function configured() { return !!key(); }
function encrypt(text, what = "sensitive fields") {
  const k = key();
  if (!k) throw Object.assign(new Error(`ID_ENCRYPTION_KEY is not set on the server, so ${what} can't be stored yet.`), { status: 503 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}
function decrypt(blob) {
  if (!blob) return null;
  const k = key(); if (!k) return null;
  const [v, iv, tag, data] = String(blob).split(":");
  if (v !== "v1") return null;
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

module.exports = { configured, encrypt, decrypt };
