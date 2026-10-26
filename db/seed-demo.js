// Sandbox / demo dataset for Yard-Built.
//
// Loads a fictional four-yard company ("High Plains Metal Recycling") — dealers, customers,
// carriers, lanes, commodities, contracts, POs and about two months of posted tickets — so a
// sandbox deployment has something realistic to click around in, with no real customer data.
//
// Usage:
//   npm run seed:demo             idempotent: loads the dataset only if the demo marker isn't set
//   npm run seed:demo -- --reset  wipes every table and reloads — refuses unless SANDBOX=1, so it
//                                 can't be pointed at production by accident
//
// Also used by POST /sandbox/reset (src/routes/sandbox.js) via module.exports.seedDemo().
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, query } = require("../src/db");

const DEMO_MARKER = "demoDataset";
const DEMO_LOGIN = { email: "demo@yardbuilt.net", password: "demo1234" };

const COMPANY = "High Plains Metal Recycling";

// Yard codes are shared with the UI's hardcoded YARDS list, so they stay the same; the names here
// are published to app_settings.yardNames and the UI swaps them in after login.
const YARDS = [
  { code: "SB",    name: "North Yard (Main)", address: "1400 Industrial Dr, Cedar Falls, NE", zip: "68901", state: "NE" },
  { code: "HAYS",  name: "East Yard",         address: "880 Railroad Ave, Prairie City, KS",  zip: "67002", state: "KS" },
  { code: "COLBY", name: "West Yard",         address: "2210 Hwy 24, Millbrook, KS",          zip: "67701", state: "KS" },
  { code: "RC",    name: "River Yard",        address: "3100 Riverside Rd, Black Hawk, SD",   zip: "57701", state: "SD" },
];

const BANK_ACCOUNTS = [
  { yard: "SB",    bankName: "First Prairie Bank",       last4: "2210", startingBalance: 38000, nextCheck: 5001 },
  { yard: "HAYS",  bankName: "Frontier Community Bank",  last4: "7714", startingBalance: 16500, nextCheck: 3001 },
  { yard: "COLBY", bankName: "Western Plains Bank",      last4: "9031", startingBalance: 19250, nextCheck: 2001 },
  { yard: "RC",    bankName: "Black Hawk State Bank",    last4: "4487", startingBalance: 14800, nextCheck: 1001 },
];

const ROLES = [
  { name: "Admin", system: true, permissions: ["buttonMaker","voidTickets","editPricing","manageUsers","assignWorkOrderItems","adjustInventory","regradeInventory","packInventory","addCommodity","payRemittances","editBankAccounts","viewIds","manageDocuments"] },
  { name: "Yard Manager", system: false, permissions: ["buttonMaker","voidTickets","editPricing","manageUsers","assignWorkOrderItems","regradeInventory","packInventory","payRemittances","viewIds","manageDocuments"] },
  { name: "Cashier", system: false, permissions: ["voidTickets","payRemittances"] },
  { name: "Scale Operator", system: false, permissions: ["packInventory"] },
  { name: "Mechanic", system: false, permissions: [] },
];

// Fixed ids so a signed-in admin's token survives a reset (tokens carry the user id).
const USERS = [
  { id: "demo-admin",   name: "Demo Admin",   email: DEMO_LOGIN.email,        role: "Admin",          title: "Owner",          homeYard: "SB",    yards: [] },
  { id: "demo-manager", name: "Jordan Reyes", email: "manager@yardbuilt.net", role: "Yard Manager",   title: "Yard Manager",   homeYard: "HAYS",  yards: ["HAYS", "COLBY"] },
  { id: "demo-cashier", name: "Casey Nguyen", email: "cashier@yardbuilt.net", role: "Cashier",        title: "Cashier",        homeYard: "SB",    yards: ["SB"] },
  { id: "demo-scale",   name: "Sam Okafor",   email: "scale@yardbuilt.net",   role: "Scale Operator", title: "Scale Operator", homeYard: "RC",    yards: ["RC"] },
];

// master_price is stored per lb regardless of unit (the UI converts ferrous to $/net ton).
const COMMODITIES = [
  { code: "HMS1",     name: "HMS #1 Steel",            category: "Ferrous",   ferrous: true,  unit: "net_ton", low: 40000, price: 0.1050, color: "steel-dark" },
  { code: "HMS2",     name: "HMS #2 Steel",            category: "Ferrous",   ferrous: true,  unit: "net_ton", low: 40000, price: 0.0900, color: "steel-dark" },
  { code: "P&S",      name: "Plate & Structural",      category: "Ferrous",   ferrous: true,  unit: "net_ton", low: 20000, price: 0.1150, color: "steel-blue" },
  { code: "SHRED",    name: "Shred Feed / Sheet Iron", category: "Ferrous",   ferrous: true,  unit: "net_ton", low: 60000, price: 0.0725, color: "steel-blue" },
  { code: "CAST",     name: "Cast Iron",               category: "Ferrous",   ferrous: true,  unit: "net_ton", low: 10000, price: 0.0950, color: "steel-dark" },
  { code: "AUTO",     name: "Auto Bodies",             category: "Ferrous",   ferrous: true,  unit: "net_ton", low: 30000, price: 0.0650, color: "steel-blue" },
  { code: "CU-BB",    name: "Bare Bright Copper",      category: "Copper",    ferrous: false, unit: "lb",      low: 150,   price: 3.9500, color: "copper-bright" },
  { code: "CU-1",     name: "#1 Copper",               category: "Copper",    ferrous: false, unit: "lb",      low: 200,   price: 3.7000, color: "copper-bright" },
  { code: "CU-2",     name: "#2 Copper",               category: "Copper",    ferrous: false, unit: "lb",      low: 200,   price: 3.4000, color: "copper-deep" },
  { code: "ICW-1",    name: "#1 Insulated Wire",       category: "Copper",    ferrous: false, unit: "lb",      low: 300,   price: 2.1000, color: "icw-coral" },
  { code: "ICW-2",    name: "#2 Insulated Wire",       category: "Copper",    ferrous: false, unit: "lb",      low: 300,   price: 1.1500, color: "icw-peach" },
  { code: "BR-YEL",   name: "Yellow Brass",            category: "Brass",     ferrous: false, unit: "lb",      low: 200,   price: 2.1500, color: "brass-gold" },
  { code: "BR-RED",   name: "Red Brass",               category: "Brass",     ferrous: false, unit: "lb",      low: 100,   price: 2.4500, color: "brass-burnt" },
  { code: "AL-CANS",  name: "Aluminum Cans",           category: "Aluminum",  ferrous: false, unit: "lb",      low: 200,   price: 0.6200, color: "alum-cyan" },
  { code: "AL-EXT",   name: "Aluminum Extrusion",      category: "Aluminum",  ferrous: false, unit: "lb",      low: 300,   price: 0.7800, color: "alum-blue" },
  { code: "AL-SHEET", name: "Aluminum Sheet / Siding", category: "Aluminum",  ferrous: false, unit: "lb",      low: 400,   price: 0.6000, color: "alum-teal" },
  { code: "AL-RIMS",  name: "Aluminum Rims",           category: "Aluminum",  ferrous: false, unit: "lb",      low: 300,   price: 0.7200, color: "alum-navy" },
  { code: "AL-CAST",  name: "Aluminum Cast",           category: "Aluminum",  ferrous: false, unit: "lb",      low: 300,   price: 0.5500, color: "alum-slate" },
  { code: "ACR",      name: "ACR (Alum/Copper Rads)",  category: "ACR",       ferrous: false, unit: "lb",      low: 200,   price: 1.3500, color: "acr-teal" },
  { code: "SS-304",   name: "Stainless 304",           category: "Stainless", ferrous: false, unit: "lb",      low: 400,   price: 0.5200, color: "ss-silver" },
  { code: "SS-316",   name: "Stainless 316",           category: "Stainless", ferrous: false, unit: "lb",      low: 100,   price: 0.7200, color: "ss-slate" },
  { code: "PB-SOFT",  name: "Soft Lead",               category: "Lead",      ferrous: false, unit: "lb",      low: 200,   price: 0.6000, color: "lead-red" },
  { code: "BATT",     name: "Lead-Acid Batteries",     category: "Lead",      ferrous: false, unit: "lb",      low: 500,   price: 0.2200, color: "lead-maroon" },
  { code: "E-MB",     name: "Motherboards",            category: "E-Scrap",   ferrous: false, unit: "lb",      low: 50,    price: 1.6000, color: "cb-purple" },
  { code: "E-MOTOR",  name: "Electric Motors",         category: "E-Scrap",   ferrous: false, unit: "lb",      low: 300,   price: 0.1900, color: "cb-violet" },
  { code: "CONV-L",   name: "Catalytic Converter (Large)", category: "Converter", ferrous: false, unit: "each", low: 5,  price: 95.00,  color: "conv-charcoal", askPrice: true },
  { code: "CONV-S",   name: "Catalytic Converter (Small)", category: "Converter", ferrous: false, unit: "each", low: 5,  price: 45.00,  color: "conv-charcoal", askPrice: true },
];

// Dealers (vendors who sell scrap to the yard). Mix of commercial accounts on tiers and walk-ins.
const VENDORS = [
  { name: "Prairie View Salvage",          phone: "308-555-0142", tier: "dh",    onList: true,  notes: "Commercial — weekly ferrous" , address: "4120 County Rd 14, Cedar Falls, NE" },
  { name: "Cedar Falls Auto Wrecking",     phone: "308-555-0173", tier: "d1",    onList: true,  notes: "Auto bodies, rims, converters", address: "900 Salvage Ln, Cedar Falls, NE" },
  { name: "Northline Electrical Contractors", phone: "308-555-0188", tier: "d1", onList: true,  notes: "Wire & motors", address: "212 Commerce St, Cedar Falls, NE" },
  { name: "Lone Pine Farms",               phone: "308-555-0109", tier: "d2",    onList: true,  notes: "Farm iron, seasonal" },
  { name: "Riverbend Plumbing & Heating",  phone: "308-555-0121", tier: "d2",    onList: true,  notes: "Copper, brass" },
  { name: "Dale Henderson",                phone: "308-555-0198", tier: "scale", onList: false, notes: "Walk-in regular" },
  { name: "Dale Hendersen",                phone: "308-555-0198", tier: "scale", onList: false, notes: "" }, // intentional near-duplicate (Exceptions report demo)
  { name: "Marisol Ortega",                phone: "308-555-0134", tier: "scale", onList: false, notes: "" },
  { name: "Tanner Whitfield",              phone: "308-555-0167", tier: "scale", onList: false, notes: "" },
  { name: "Prairie City Fabrication",      phone: "785-555-0150", tier: "dh",    onList: true,  notes: "Commercial — P&S drops", address: "1500 Industrial Pkwy, Prairie City, KS" },
  { name: "Sunflower Grain Co-op",         phone: "785-555-0177", tier: "d1",    onList: true,  notes: "Bin tear-outs" },
  { name: "Hollis Brothers Demolition",    phone: "785-555-0163", tier: "d1",    onList: true,  notes: "Demo iron, roll-offs" },
  { name: "Eastgate HVAC",                 phone: "785-555-0139", tier: "d2",    onList: true,  notes: "ACR, motors" },
  { name: "Ruth Castillo",                 phone: "785-555-0181", tier: "scale", onList: false, notes: "" },
  { name: "Kevin Bramwell",                phone: "785-555-0115", tier: "scale", onList: false, notes: "" },
  { name: "Millbrook Implement",           phone: "785-555-0192", tier: "dh",    onList: true,  notes: "Commercial — cast & farm iron", address: "700 W Hwy 24, Millbrook, KS" },
  { name: "West Plains Towing",            phone: "785-555-0146", tier: "d1",    onList: true,  notes: "Auto bodies" },
  { name: "Greg & Sons Roofing",           phone: "785-555-0128", tier: "d2",    onList: true,  notes: "Aluminum sheet" },
  { name: "Angela Pruitt",                 phone: "785-555-0104", tier: "scale", onList: false, notes: "" },
  { name: "Black Hawk Machine Shop",       phone: "605-555-0157", tier: "dh",    onList: true,  notes: "Commercial — turnings, stainless", address: "2400 Riverside Rd, Black Hawk, SD" },
  { name: "Rushmore Electric Co-op",       phone: "605-555-0170", tier: "d1",    onList: true,  notes: "Wire, transformers" },
  { name: "Hillside Auto Parts",           phone: "605-555-0183", tier: "d1",    onList: true,  notes: "Rims, converters, batteries" },
  { name: "Dakota Appliance Recycling",    phone: "605-555-0112", tier: "d2",    onList: true,  notes: "White goods, motors" },
  { name: "Luis Fernandez",                phone: "605-555-0149", tier: "scale", onList: false, notes: "" },
  { name: "Walk-in",                       phone: null,           tier: "scale", onList: false, notes: "Catch-all walk-in record" },
];

// Customers (mills / brokers the yard sells to).
const CUSTOMERS = [
  { name: "Midwest Steel Mill",          phone: "402-555-0200", tier: "dh", freight: 0.018, terms: "net30", address: "1 Mill Rd, Steel City, NE",        exempt: true },
  { name: "Great Plains Metals Trading", phone: "816-555-0211", tier: "dh", freight: 0.022, terms: "net15", address: "5500 Front St, Kansas City, MO",     exempt: true },
  { name: "Front Range Shredding",       phone: "303-555-0222", tier: "d1", freight: 0.015, terms: "net30", address: "9800 Brighton Blvd, Denver, CO",     exempt: true },
  { name: "Rocky Mountain Nonferrous",   phone: "303-555-0233", tier: "dh", freight: 0.025, terms: "net15", address: "4100 E 48th Ave, Denver, CO",        exempt: true },
  { name: "Heartland Copper Refining",   phone: "913-555-0244", tier: "dh", freight: 0.030, terms: "net30", address: "200 Refinery Way, Olathe, KS",       exempt: true },
  { name: "Northern Aluminum Smelter",   phone: "612-555-0255", tier: "d1", freight: 0.028, terms: "net30", address: "1200 River Pkwy, St. Paul, MN",      exempt: true },
  { name: "Tri-State Converter Buyers",  phone: "720-555-0266", tier: "d1", freight: 0.000, terms: "cod",   address: "77 Commerce Ct, Aurora, CO",         exempt: true },
  { name: "Walk-in",                     phone: null,           tier: "scale", freight: 0, terms: "cod", address: null, exempt: false },
];

const CARRIERS = [
  { name: "HPMR Truck 205 (Semi)",       phone: null,           mc: null,       type: "owned",     container: false },
  { name: "HPMR Roll-Off 206",           phone: null,           mc: null,       type: "owned",     container: true },
  { name: "Redline Trucking",            phone: "308-555-0110", mc: "MC-482910", type: "common",   container: false },
  { name: "Prairie Freight Lines",       phone: "785-555-0119", mc: "MC-517734", type: "dedicated", container: false },
  { name: "Dakota Flatbed LLC",          phone: "605-555-0123", mc: "MC-601288", type: "common",   container: false },
];

const LANES = [
  { origin: "North Yard (Main)", destination: "Midwest Steel Mill — Steel City, NE",      carrier: "Prairie Freight Lines", basis: "flat",    rate: 650 },
  { origin: "North Yard (Main)", destination: "Rocky Mountain Nonferrous — Denver, CO",   carrier: "Redline Trucking",      basis: "flat",    rate: 900 },
  { origin: "East Yard",         destination: "Great Plains Metals Trading — Kansas City, MO", carrier: "Redline Trucking", basis: "per_ton", rate: 28 },
  { origin: "River Yard",        destination: "Front Range Shredding — Denver, CO",       carrier: "Dakota Flatbed LLC",    basis: "flat",    rate: 1100 },
];

const TIER_MARGINS = { scale: 0.30, d2: 0.22, d1: 0.15, dh: 0.08 }; // discount off master (sale) price

// ---------------------------------------------------------------------------------------------

function tierPrice(master, tier) {
  const m = TIER_MARGINS[tier] ?? TIER_MARGINS.scale;
  return Math.round(master * (1 - m) * 10000) / 10000;
}

// Deterministic pseudo-random so every reset produces the same dataset.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function isoDaysAgo(n) {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function isSeeded() {
  const { rows } = await query("SELECT value FROM app_settings WHERE key = $1", [DEMO_MARKER]);
  return rows.length > 0;
}

// Empties every application table (not schema_migrations) and resets the ticket sequences.
async function wipe() {
  if (process.env.SANDBOX !== "1") throw new Error("Refusing to wipe: SANDBOX=1 is not set on this server.");
  const { rows } = await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  await query("ALTER SEQUENCE ticket_buy_seq RESTART WITH 1001");
  await query("ALTER SEQUENCE ticket_sell_seq RESTART WITH 2001");
}

async function postTicket(t, byUserId) {
  const seqName = t.type === "buy" ? "ticket_buy_seq" : "ticket_sell_seq";
  const prefix = t.type === "buy" ? "B" : "S";
  const { rows: seqRows } = await query(`SELECT nextval($1) AS n`, [seqName]);
  const id = `${prefix}-${seqRows[0].n}`;

  const { rows: invRows } = await query("SELECT * FROM inventory_balances WHERE yard = $1 AND commodity = $2", [t.yard, t.commodity]);
  const inv = invRows[0];
  const qty = parseFloat(inv.qty), avgCost = parseFloat(inv.avg_cost);
  let newQty, newAvgCost, cogsPerLb = null, ledgerType;
  if (t.type === "buy") {
    newQty = qty + t.netWeight;
    newAvgCost = newQty > 0 ? (qty * avgCost + t.netWeight * t.price) / newQty : t.price;
    ledgerType = "Buy";
  } else {
    newQty = qty - t.netWeight;
    newAvgCost = avgCost;
    cogsPerLb = avgCost;
    ledgerType = "Sell";
  }
  await query("UPDATE inventory_balances SET qty = $3, avg_cost = $4, updated_at = now() WHERE yard = $1 AND commodity = $2", [t.yard, t.commodity, newQty, newAvgCost]);
  const total = Math.round(t.netWeight * t.price * 100) / 100;
  await query(
    `INSERT INTO tickets (id, type, date, yard, vendor_id, customer_id, party_name, commodity, tier, net_weight, price, total, payment, status, paid, cogs_per_lb, contract_id, po_id, created_by, closed_at, closed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, $3::date + time '14:30', $19)`,
    [id, t.type, t.date, t.yard, t.vendorId || null, t.customerId || null, t.partyName, t.commodity, t.tier || null, t.netWeight, t.price, total, t.payment,
     t.status || "Closed", !!t.paid, cogsPerLb, t.contractId || null, t.poId || null, byUserId]
  );
  await query(
    `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date, time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [t.yard, t.commodity, ledgerType, t.type === "buy" ? t.netWeight : -t.netWeight, t.type === "buy" ? t.price : null,
     newQty, newAvgCost, Math.round(newQty * newAvgCost * 100) / 100, id, t.date, "14:30"]
  );
  if (t.contractId) await query("UPDATE contracts SET shipped_qty = shipped_qty + $2 WHERE id = $1", [t.contractId, t.netWeight]);
  if (t.poId) await query("UPDATE purchase_orders SET received_qty = received_qty + $2 WHERE id = $1", [t.poId, t.netWeight]);
  return id;
}

async function load() {
  const rng = makeRng(20261026);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  for (const y of YARDS) {
    await query(
      `INSERT INTO yards (code, name, address, zip, state) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, zip = EXCLUDED.zip, state = EXCLUDED.state`,
      [y.code, y.name, y.address, y.zip, y.state]
    );
  }
  for (const b of BANK_ACCOUNTS) {
    await query(
      `INSERT INTO bank_accounts (yard, bank_name, last4, starting_balance, next_check_number) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (yard) DO UPDATE SET bank_name = EXCLUDED.bank_name, last4 = EXCLUDED.last4, starting_balance = EXCLUDED.starting_balance`,
      [b.yard, b.bankName, b.last4, b.startingBalance, b.nextCheck]
    );
  }

  const roleIds = {};
  for (const r of ROLES) {
    const { rows } = await query(
      `INSERT INTO roles (name, system, permissions) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions RETURNING id`,
      [r.name, r.system, r.permissions]
    );
    roleIds[r.name] = rows[0].id;
  }

  const hash = await bcrypt.hash(DEMO_LOGIN.password, 10);
  const userIds = {};
  for (const u of USERS) {
    const { rows } = await query(
      `INSERT INTO users (id, name, email, password_hash, role_id, title, home_yard, yards, must_change_password, active)
       VALUES ($8,$1,$2,$3,$4,$5,$6,$7,false,true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role_id = EXCLUDED.role_id, must_change_password = false, active = true
       RETURNING id`,
      [u.name, u.email, hash, roleIds[u.role], u.title, u.homeYard, u.yards, u.id]
    );
    userIds[u.email] = rows[0].id;
  }
  const adminId = userIds[DEMO_LOGIN.email];

  for (const c of COMMODITIES) {
    await query(
      `INSERT INTO commodities (code, name, category, ferrous, unit, low_threshold, master_price, kiosk_color, ask_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, master_price = EXCLUDED.master_price`,
      [c.code, c.name, c.category, c.ferrous, c.unit, c.low, c.price, c.color, !!c.askPrice]
    );
    for (const y of YARDS) {
      await query(
        `INSERT INTO inventory_balances (yard, commodity, qty, avg_cost) VALUES ($1,$2,0,$3)
         ON CONFLICT (yard, commodity) DO NOTHING`,
        [y.code, c.code, tierPrice(c.price, "d1")]
      );
    }
  }

  const vendorIds = {};
  for (const v of VENDORS) {
    const { rows } = await query(
      `INSERT INTO vendors (name, phone, tier, notes, on_price_list, address, smartphone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [v.name, v.phone, v.tier, v.notes || "", v.onList, v.address || null, v.onList]
    );
    vendorIds[v.name] = rows[0].id;
  }
  const customerIds = {};
  for (const c of CUSTOMERS) {
    const { rows } = await query(
      `INSERT INTO customers (name, phone, tier, freight_per_lb, terms, address, business_exempt) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [c.name, c.phone, c.tier, c.freight, c.terms, c.address, c.exempt]
    );
    customerIds[c.name] = rows[0].id;
  }
  const carrierIds = {};
  for (const c of CARRIERS) {
    const { rows } = await query(
      `INSERT INTO carriers (name, phone, mc, type, is_container_truck) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [c.name, c.phone, c.mc, c.type, c.container]
    );
    carrierIds[c.name] = rows[0].id;
  }
  for (const l of LANES) {
    await query(
      `INSERT INTO freight_lanes (origin, destination, carrier_id, rate_basis, rate) VALUES ($1,$2,$3,$4,$5)`,
      [l.origin, l.destination, carrierIds[l.carrier], l.basis, l.rate]
    );
  }

  // Open contracts (sales commitments) and purchase orders.
  const contracts = [
    { id: "CT-1001", customer: "Midwest Steel Mill",          commodity: "HMS1",  yard: "SB",    qty: 400000, end: isoDaysAgo(-20), notes: "5 railcars, prepared #1" },
    { id: "CT-1002", customer: "Rocky Mountain Nonferrous",   commodity: "CU-2",  yard: "SB",    qty: 20000,  end: isoDaysAgo(-35), notes: "Monthly copper load" },
    { id: "CT-1003", customer: "Great Plains Metals Trading", commodity: "SHRED", yard: "HAYS",  qty: 300000, end: isoDaysAgo(-10), notes: "Shred feed, 6 trucks" },
    { id: "CT-1004", customer: "Northern Aluminum Smelter",   commodity: "AL-EXT", yard: "RC",   qty: 40000,  end: isoDaysAgo(-45), notes: "Baled extrusion" },
  ];
  for (const c of contracts) {
    await query(
      `INSERT INTO contracts (id, customer_id, commodity, yard, committed_qty, end_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c.id, customerIds[c.customer], c.commodity, c.yard, c.qty, c.end, c.notes]
    );
  }
  const pos = [
    { id: "PO-1001", vendor: "Prairie View Salvage",     commodity: "HMS1", yard: "SB",    qty: 200000, end: isoDaysAgo(-15), notes: "Standing weekly pickup" },
    { id: "PO-1002", vendor: "Hollis Brothers Demolition", commodity: "P&S", yard: "HAYS", qty: 120000, end: isoDaysAgo(-30), notes: "Grain elevator demo" },
    { id: "PO-1003", vendor: "Black Hawk Machine Shop",  commodity: "SS-304", yard: "RC",  qty: 6000,   end: isoDaysAgo(-25), notes: "Turnings, drums" },
  ];
  for (const p of pos) {
    await query(
      `INSERT INTO purchase_orders (id, vendor_id, commodity, yard, committed_qty, end_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, vendorIds[p.vendor], p.commodity, p.yard, p.qty, p.end, p.notes]
    );
  }

  // ~60 days of activity. Each yard gets a handful of buys per weekday from its own dealers,
  // ferrous in truck-sized lots and nonferrous in walk-in sized lots, plus periodic sales.
  const yardDealers = {
    SB:    VENDORS.slice(0, 9).map((v) => v.name),
    HAYS:  VENDORS.slice(9, 15).map((v) => v.name),
    COLBY: VENDORS.slice(15, 19).map((v) => v.name),
    RC:    VENDORS.slice(19, 24).map((v) => v.name),
  };
  const vendorByName = Object.fromEntries(VENDORS.map((v) => [v.name, v]));
  const comByCode = Object.fromEntries(COMMODITIES.map((c) => [c.code, c]));
  const ferrousCodes = ["HMS1", "HMS2", "P&S", "SHRED", "CAST", "AUTO"];
  const nfCodes = COMMODITIES.filter((c) => !c.ferrous && c.unit === "lb").map((c) => c.code);
  const buyPlan = [];
  for (let d = 62; d >= 0; d--) {
    const dow = new Date(isoDaysAgo(d) + "T12:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const y of YARDS) {
      const n = y.code === "SB" ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const dealerName = pick(yardDealers[y.code]);
        const dealer = vendorByName[dealerName];
        const ferrous = rng() < (dealer.tier === "scale" ? 0.25 : 0.55);
        const code = ferrous ? pick(ferrousCodes) : pick(nfCodes);
        const c = comByCode[code];
        const weight = ferrous ? Math.round((8000 + rng() * 34000) / 20) * 20 : Math.round(20 + rng() * (c.price > 2 ? 300 : 900));
        const tier = dealer.tier;
        buyPlan.push({
          type: "buy", date: isoDaysAgo(d), yard: y.code, vendorId: vendorIds[dealerName], partyName: dealerName,
          commodity: code, tier, netWeight: weight, price: tierPrice(c.price, tier),
          payment: dealer.tier === "scale" ? "Check" : (rng() < 0.6 ? "ACH" : "Check"),
          paid: d > 3, status: d > 1 ? "Closed" : (rng() < 0.5 ? "Held" : "Closed"),
          poId: code === "HMS1" && y.code === "SB" && dealerName === "Prairie View Salvage" ? "PO-1001" : (code === "P&S" && y.code === "HAYS" && dealerName === "Hollis Brothers Demolition" ? "PO-1002" : null),
        });
      }
    }
  }
  for (const t of buyPlan) await postTicket(t, adminId);

  // Sales: roughly weekly ferrous loads and a couple of nonferrous loads per yard, sized to what
  // is on hand so inventory never goes negative in the demo.
  const salesPlan = [];
  for (let d = 56; d >= 2; d -= 7) {
    salesPlan.push({ yard: "SB",    customer: "Midwest Steel Mill",          commodity: "HMS1",  share: 0.7, contractId: "CT-1001" });
    salesPlan.push({ yard: "HAYS",  customer: "Great Plains Metals Trading", commodity: "SHRED", share: 0.8, contractId: "CT-1003" });
    salesPlan.push({ yard: "COLBY", customer: "Front Range Shredding",       commodity: "SHRED", share: 0.8 });
    salesPlan.push({ yard: "RC",    customer: "Midwest Steel Mill",          commodity: "HMS2",  share: 0.7 });
    if (d % 14 === 0) {
      salesPlan.push({ yard: "SB", customer: "Rocky Mountain Nonferrous", commodity: "CU-2",   share: 0.9, contractId: "CT-1002" });
      salesPlan.push({ yard: "SB", customer: "Heartland Copper Refining", commodity: "CU-1",   share: 0.9 });
      salesPlan.push({ yard: "RC", customer: "Northern Aluminum Smelter", commodity: "AL-EXT", share: 0.9, contractId: "CT-1004" });
      salesPlan.push({ yard: "HAYS", customer: "Rocky Mountain Nonferrous", commodity: "BR-YEL", share: 0.9 });
    }
    for (const s of salesPlan.splice(0)) {
      const { rows } = await query("SELECT qty FROM inventory_balances WHERE yard = $1 AND commodity = $2", [s.yard, s.commodity]);
      const onHand = parseFloat(rows[0].qty);
      const weight = Math.floor(onHand * s.share);
      if (weight < 100) continue;
      const c = comByCode[s.commodity];
      await postTicket({
        type: "sell", date: isoDaysAgo(d), yard: s.yard, customerId: customerIds[s.customer], partyName: s.customer,
        commodity: s.commodity, netWeight: weight, price: Math.round(c.price * 1.02 * 10000) / 10000,
        payment: "ACH", paid: d > 20, status: "Closed", contractId: s.contractId || null,
      }, adminId);
    }
  }

  await query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES
       ('tierMargins', $1, now(), $4),
       ('companyName', $2, now(), $4),
       ('yardNames', $3, now(), $4),
       ($5, $6, now(), $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(TIER_MARGINS), JSON.stringify(COMPANY), JSON.stringify(Object.fromEntries(YARDS.map((y) => [y.code, y.name]))), adminId,
     DEMO_MARKER, JSON.stringify({ loadedAt: new Date().toISOString(), company: COMPANY })]
  );
}

// reset=true wipes first (SANDBOX=1 only). Without reset, loads only when the marker is absent.
async function seedDemo({ reset = false } = {}) {
  if (reset) await wipe();
  else if (await isSeeded()) return { skipped: true };
  await load();
  return { skipped: false, login: DEMO_LOGIN };
}

module.exports = { seedDemo, DEMO_LOGIN, COMPANY };

if (require.main === module) {
  const reset = process.argv.includes("--reset");
  seedDemo({ reset })
    .then((r) => {
      if (r.skipped) console.log("Demo dataset already loaded — nothing to do (use --reset with SANDBOX=1 to reload).");
      else console.log(`Demo dataset loaded. Login: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
    })
    .catch((err) => { console.error("Demo seed failed:", err); process.exitCode = 1; })
    .finally(() => pool.end());
}
