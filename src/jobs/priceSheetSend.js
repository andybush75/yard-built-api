// Job: text dealers their price sheet.
//
// Payload (all optional):
//   yard       "SB" | "HAYS" | "COLBY" | "RC"   — only dealers of this yard (default: every yard)
//   vendorIds  [id, ...]                          — exactly these dealers, whatever their auto-send
//                                                   setting (what "Send now" on a dealer's row sends)
//   reason     text shown in the log, e.g. "Prices updated"
//
// Who gets a text on the scheduled run: active dealers that are on the price list with
// auto_send = 'daily'. A run triggered by a price update also includes auto_send = 'update'.
// Prices come from the same engine the app uses everywhere: master_price × yardMult[yard] ×
// (1 − tierMargins[tier]), read from app_settings so Settings changes apply immediately.
//
// Sending: Twilio REST API when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN and either TWILIO_FROM or
// TWILIO_MESSAGING_SERVICE_SID are set. Without them, or on the sandbox, every message is logged
// as dry_run with the exact body that would have gone out — so the whole flow can be exercised
// before a single real text is sent. The image (PDF→JPEG MMS) version of the sheet is not built
// yet; this sends the sheet as text.
const { query } = require("../db");

const TIER_LABEL = { scale: "Scale", d2: "D2", d1: "D1", dh: "D-High" };
const MAX_SMS_CHARS = 1500; // Twilio concatenates up to 1600; leave room

function r3(n) { return Math.round(n * 1000) / 1000; }

async function loadSettings() {
  const { rows } = await query("SELECT key, value FROM app_settings WHERE key IN ('tierMargins','yardMult','priceSheet','companyName','yardNames')");
  const s = {}; rows.forEach((r) => { s[r.key] = r.value; });
  return {
    tierMargins: s.tierMargins || { scale: 0.12, d2: 0.08, d1: 0.05, dh: 0.02 },
    yardMult: s.yardMult || {},
    defaultYard: (s.priceSheet && s.priceSheet.defaultYard) || "SB",
    companyName: s.companyName || "Langer Industrial",
    yardNames: s.yardNames || {},
  };
}

function unitLabel(u) { return u === "net_ton" ? "/NT" : u === "gross_ton" ? "/GT" : u === "each" ? " ea" : "/lb"; }
function priceInUnit(perLb, unit) {
  if (unit === "net_ton") return perLb * 2000;
  if (unit === "gross_ton") return perLb * 2240;
  return perLb;
}

function buildBody({ companyName, yardName, tier, commodities, settings, yard, date }) {
  const mult = settings.yardMult[yard] ?? 1;
  const margin = settings.tierMargins[tier] ?? 0;
  const lines = [`${companyName} ${yardName} prices ${date} (${TIER_LABEL[tier] || tier})`];
  let category = null;
  for (const c of commodities) {
    if (c.category !== category) { category = c.category; lines.push(`— ${category} —`); }
    const perLb = r3(Number(c.master_price) * mult * (1 - margin));
    const shown = priceInUnit(perLb, c.unit);
    const digits = c.unit === "net_ton" || c.unit === "gross_ton" || c.unit === "each" ? 2 : 3;
    lines.push(`${c.name} $${shown.toFixed(digits)}${unitLabel(c.unit)}`);
  }
  lines.push("Prices subject to change. Reply STOP to opt out.");
  let body = lines.join("\n");
  let truncated = false;
  if (body.length > MAX_SMS_CHARS) {
    truncated = true;
    body = body.slice(0, MAX_SMS_CHARS - 60).replace(/\n[^\n]*$/, "") + "\n…more items — call the yard for the full sheet.";
  }
  return { body, truncated };
}

function twilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM, mss = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || !(from || mss)) return null;
  return { sid, token, from, mss };
}

async function sendTwilio(cfg, to, body) {
  const params = new URLSearchParams({ To: to, Body: body });
  if (cfg.mss) params.set("MessagingServiceSid", cfg.mss); else params.set("From", cfg.from);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Twilio HTTP ${res.status}`);
  return json.sid;
}

function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return null;
}

module.exports = async function priceSheetSend(ctx, payload = {}) {
  const settings = await loadSettings();
  const cfg = ctx.sandbox ? null : twilioConfig();
  const dryRun = !cfg;
  const date = new Date().toLocaleDateString("en-US", { timeZone: "America/Denver", month: "numeric", day: "numeric" });

  // Who
  const params = [];
  let where = "v.active AND v.on_price_list";
  if (payload.vendorIds && payload.vendorIds.length) {
    params.push(payload.vendorIds); where = `v.id = ANY($${params.length})`;
  } else {
    const modes = payload.reason ? ["daily", "update"] : ["daily"];
    params.push(modes); where += ` AND v.auto_send = ANY($${params.length})`;
  }
  const { rows: vendors } = await query(
    `SELECT v.id, v.name, v.phone, v.tier, v.smartphone, v.home_yard FROM vendors v WHERE ${where} ORDER BY v.name`, params
  );
  const targetYard = payload.yard || null;
  const { rows: yardRows } = await query("SELECT code, name FROM yards");
  const yardName = (code) => (settings.yardNames[code]) || (yardRows.find((y) => y.code === code) || {}).name || code;

  // What — non-ferrous commodities the kiosk shows with a real price, grouped like the sheet.
  const { rows: commodities } = await query(
    `SELECT code, name, category, unit, master_price FROM commodities
     WHERE kiosk_show AND NOT ferrous AND master_price > 0 ORDER BY category, name`
  );
  if (!commodities.length) return { skipped: "No priced non-ferrous commodities to send" };

  const bodies = new Map(); // `${yard}|${tier}` -> body
  const counts = { sent: 0, dry_run: 0, failed: 0, skipped: 0 };
  let truncatedAny = false;
  const explicit = !!(payload.vendorIds && payload.vendorIds.length);
  for (const v of vendors) {
    // A "Send now" for named dealers sends the yard the admin was looking at; the schedule sends
    // each dealer their own yard.
    const yard = explicit && targetYard ? targetYard : (v.home_yard || settings.defaultYard);
    if (targetYard && yard !== targetYard) continue;
    const key = `${yard}|${v.tier}`;
    if (!bodies.has(key)) {
      const b = buildBody({ companyName: settings.companyName, yardName: yardName(yard), tier: v.tier, commodities, settings, yard, date });
      truncatedAny = truncatedAny || b.truncated;
      bodies.set(key, b.body);
    }
    const body = bodies.get(key);
    const to = normalizePhone(v.phone);
    const channel = v.smartphone === false ? "SMS" : "MMS";
    const row = { vendor_id: v.id, vendor_name: v.name, phone: v.phone || null, yard, tier: v.tier, channel: "SMS", status: "skipped", detail: null, twilio_sid: null, body };
    if (!to) {
      row.detail = v.phone ? `Unusable phone number: ${v.phone}` : "No phone number on file";
    } else if (dryRun) {
      row.status = "dry_run"; row.detail = ctx.sandbox ? "Sandbox — nothing is texted from the demo server" : "Twilio is not configured (TWILIO_* variables)";
    } else {
      try { row.twilio_sid = await sendTwilio(cfg, to, body); row.status = "sent"; }
      catch (err) { row.status = "failed"; row.detail = err.message; }
    }
    void channel; // MMS (image) delivery is the next increment; everything goes as SMS text today
    counts[row.status]++;
    await query(
      `INSERT INTO price_sheet_sends (run_id, vendor_id, vendor_name, phone, yard, tier, channel, status, detail, twilio_sid, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.runId, row.vendor_id, row.vendor_name, row.phone, row.yard, row.tier, row.channel, row.status, row.detail, row.twilio_sid, row.body]
    );
    if (row.status === "sent") await query("UPDATE vendors SET last_sent = now() WHERE id = $1", [v.id]);
  }

  const result = { dealers: vendors.length, ...counts, yard: targetYard || "all", dryRun, commodities: commodities.length, groups: bodies.size };
  if (truncatedAny) result.note = `Some sheets exceeded ${MAX_SMS_CHARS} characters and were cut short — the image (MMS) version isn't built yet.`;
  if (!vendors.length) return { ...result, skipped: payload.vendorIds ? "None of the selected dealers exist" : "No dealers are set to auto-send" };
  if (counts.failed && !counts.sent && !counts.dry_run) throw new Error(`Every text failed — first error: ${(await query("SELECT detail FROM price_sheet_sends WHERE run_id = $1 AND status = 'failed' LIMIT 1", [ctx.runId])).rows[0]?.detail}`);
  return result;
};
