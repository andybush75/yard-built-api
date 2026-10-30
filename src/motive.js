// Motive (formerly KeepTruckin) — truck odometer readings for box-job mileage charges.
//
// Set ONE of these in Railway → Variables (never in code or the database):
//   MOTIVE_API_KEY      an API key from Motive (Admin → API Keys); sent as the X-Api-Key header
//   MOTIVE_OAUTH_TOKEN  an OAuth access token; sent as "Authorization: Bearer …"
// Optional: MOTIVE_API_BASE (default https://api.keeptruckin.com — Motive's long-standing API host;
// https://api.gomotive.com serves the same API).
//
// A truck is matched by its Motive fleet "number" against the Truck # the driver types on the phone,
// ignoring spaces, dashes and leading zeros ("206" = "0206" = "T-206" does not match "206" — keep the
// numbers the same in both places).

const BASE = (process.env.MOTIVE_API_BASE || "https://api.keeptruckin.com").replace(/\/+$/, "");

function configured() { return !!(process.env.MOTIVE_API_KEY || process.env.MOTIVE_OAUTH_TOKEN); }

async function call(path) {
  if (!configured()) throw Object.assign(new Error("Motive isn't connected — add MOTIVE_API_KEY in Railway Variables"), { code: "not_configured" });
  const headers = { Accept: "application/json", "X-Metric-Units": "false", "X-Time-Zone": "America/Denver" };
  if (process.env.MOTIVE_API_KEY) headers["X-Api-Key"] = process.env.MOTIVE_API_KEY;
  else headers.Authorization = "Bearer " + process.env.MOTIVE_OAUTH_TOKEN;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(BASE + path, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      const msg = (body && (body.error_message || body.error || body.message)) || text.slice(0, 200) || res.statusText;
      throw Object.assign(new Error(`Motive said ${res.status}: ${msg}`), { status: res.status });
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Motive didn't answer within 15 seconds");
    throw e;
  } finally { clearTimeout(timer); }
}

// Motive wraps list items one level deep in older versions ({ vehicles: [{ vehicle: {...} }] }).
const unwrap = (item, key) => (item && item[key] ? item[key] : item);
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=\d)/, "");

let vehicleCache = { at: 0, list: [] };
async function listVehicles(force) {
  if (!force && Date.now() - vehicleCache.at < 10 * 60000 && vehicleCache.list.length) return vehicleCache.list;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const body = await call(`/v1/vehicles?per_page=100&page_no=${page}`);
    const items = (body && body.vehicles) || [];
    items.map((v) => unwrap(v, "vehicle")).forEach((v) => out.push({
      id: v.id, number: v.number, make: v.make, model: v.model, year: v.year, status: v.status,
      odometer: v.true_odometer ?? v.odometer ?? null,
    }));
    const total = body && body.pagination ? body.pagination.total : body && body.total;
    if (!items.length || items.length < 100 || (total && out.length >= total)) break;
  }
  vehicleCache = { at: Date.now(), list: out };
  return out;
}

async function vehicleForTruck(truck) {
  const want = norm(truck);
  if (!want) return null;
  const list = await listVehicles(false);
  return list.find((v) => norm(v.number) === want) || null;
}

const day = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // YYYY-MM-DD

// Odometer readings for one vehicle between two moments (inclusive of the day on each side).
async function readings(vehicleId, from, to) {
  const start = new Date(from); start.setDate(start.getDate() - 1);
  const body = await call(`/v1/vehicle_locations/${encodeURIComponent(vehicleId)}?start_date=${day(start)}&end_date=${day(to)}&per_page=1000`);
  const raw = (body && (body.vehicle_locations || body.locations || (Array.isArray(body) ? body : []))) || [];
  return raw.map((r) => unwrap(r, "vehicle_location"))
    .map((r) => ({ at: new Date(r.located_at), odo: r.true_odometer ?? r.odometer }))
    .filter((r) => !isNaN(r.at) && r.odo != null && !isNaN(parseFloat(r.odo)))
    .map((r) => ({ at: r.at, odo: parseFloat(r.odo) }))
    .sort((a, b) => a.at - b.at);
}

// Miles a truck covered between two moments: odometer at (or just before) `to` minus odometer at
// (or just before) `from`. Returns { miles, vehicle, start, end }.
async function tripMiles(truck, from, to) {
  const vehicle = await vehicleForTruck(truck);
  if (!vehicle) throw Object.assign(new Error(`No truck numbered "${truck}" in Motive`), { code: "no_vehicle" });
  const list = await readings(vehicle.id, from, to);
  const f = new Date(from), t = new Date(to);
  const atOrBefore = (moment) => { let hit = null; for (const r of list) { if (r.at <= moment) hit = r; else break; } return hit; };
  const start = atOrBefore(f) || list.find((r) => r.at >= f) || null;
  const end = atOrBefore(t);
  if (!start || !end || end.at <= start.at) throw Object.assign(new Error(`Motive has no odometer readings for truck ${truck} over that trip`), { code: "no_readings" });
  const miles = Math.max(0, Math.round((end.odo - start.odo) * 10) / 10);
  return { miles, vehicle: { id: vehicle.id, number: vehicle.number }, start: { at: start.at, odo: start.odo }, end: { at: end.at, odo: end.odo } };
}

module.exports = { configured, listVehicles, vehicleForTruck, tripMiles };
