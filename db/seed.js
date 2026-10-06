// Seeds demo data equivalent to langer_yard_prototype.html's in-memory seed arrays, so the API
// is demonstrably non-empty and the Exceptions-report style duplicate-vendor scenario (Dale
// Hendricks / Dale Hendrix, same phone) still exists to query against.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, query } = require("../src/db");

const YARDS = [
  { code: "SB", name: "Scottsbluff (Main)", address: "417 9th Ave, Scottsbluff, NE", zip: "69361", state: "NE" },
  { code: "HAYS", name: "Hays", address: "1120 E 8th St, Hays, KS", zip: "67601", state: "KS" },
  { code: "COLBY", name: "Colby", address: "890 W 4th St, Colby, KS", zip: "67701", state: "KS" },
  { code: "RC", name: "RC", address: "2210 Deadwood Ave, Rapid City, SD", zip: "57701", state: "SD" },
];

const BANK_ACCOUNTS = [
  { yard: "SB", bankName: "Panhandle State Bank", last4: "4821", startingBalance: 42000 },
  { yard: "HAYS", bankName: "High Plains Bank & Trust", last4: "1193", startingBalance: 18500 },
  { yard: "COLBY", bankName: "Points West Community Bank", last4: "3067", startingBalance: 21750 },
  { yard: "RC", bankName: "Black Hills Regional Bank", last4: "5544", startingBalance: 15200 },
];

const ROLES = [
  { name: "Admin", system: true, permissions: ["buttonMaker","voidTickets","editPricing","manageUsers","assignWorkOrderItems","adjustInventory","regradeInventory","packInventory","addCommodity","payRemittances","editBankAccounts"] },
  { name: "Yard Manager", system: false, permissions: ["buttonMaker","voidTickets","editPricing","manageUsers","assignWorkOrderItems","regradeInventory","packInventory","payRemittances"] },
  { name: "Cashier", system: false, permissions: ["voidTickets","payRemittances"] },
  { name: "Scale Operator", system: false, permissions: ["packInventory"] },
  { name: "Mechanic", system: false, permissions: [] },
];

const COMMODITIES = [
  { code: "HMS1", name: "HMS #1 Steel", category: "Ferrous", ferrous: true, unit: "net_ton", lowThreshold: 6000, masterPrice: 0.106, kioskColor: "steel-dark" },
  { code: "HMS2", name: "HMS #2 Steel", category: "Ferrous", ferrous: true, unit: "net_ton", lowThreshold: 6000, masterPrice: 0.090, kioskColor: "steel-dark" },
  { code: "AL-CANS", name: "Aluminum Cans", category: "Aluminum", ferrous: false, unit: "lb", lowThreshold: 150, masterPrice: 0.700, kioskColor: "alum-cyan" },
  { code: "CU-BB", name: "Bare Bright Copper", category: "Copper", ferrous: false, unit: "lb", lowThreshold: 150, masterPrice: 3.975, kioskColor: "copper-bright" },
  { code: "CU-1", name: "#1 Copper", category: "Copper", ferrous: false, unit: "lb", lowThreshold: 200, masterPrice: 3.575, kioskColor: "copper-bright" },
  { code: "CU-2", name: "#2 Copper", category: "Copper", ferrous: false, unit: "lb", lowThreshold: 150, masterPrice: 3.275, kioskColor: "copper-deep" },
];

async function main() {
  console.log("Seeding yards, bank accounts, roles, users, commodities, vendors, customers, carriers, contracts, purchase orders, and demo tickets...");

  for (const y of YARDS) {
    await query(
      `INSERT INTO yards (code, name, address, zip, state) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [y.code, y.name, y.address, y.zip, y.state]
    );
  }
  for (const b of BANK_ACCOUNTS) {
    await query(
      `INSERT INTO bank_accounts (yard, bank_name, last4, starting_balance) VALUES ($1,$2,$3,$4)
       ON CONFLICT (yard) DO NOTHING`,
      [b.yard, b.bankName, b.last4, b.startingBalance]
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

  // Andy's own login — change this password after the first real login.
  const andyHash = await bcrypt.hash("changeme123", 10);
  await query(
    `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO NOTHING`,
    ["Andy Bush", "andy.bush@langerindustrial.com", andyHash, roleIds["Admin"]]
  );

  // Demo-only scale operator so the smoke test can prove that permission checks actually deny
  // someone. Fictional, like the vendors below — never seed this into production.
  await query(
    `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO NOTHING`,
    ["Demo Scale Operator", "scale.demo@example.com", andyHash, roleIds["Scale Operator"]]
  );

  for (const c of COMMODITIES) {
    await query(
      `INSERT INTO commodities (code, name, category, ferrous, unit, low_threshold, master_price, kiosk_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO NOTHING`,
      [c.code, c.name, c.category, c.ferrous, c.unit, c.lowThreshold, c.masterPrice, c.kioskColor]
    );
    for (const y of YARDS) {
      await query(
        `INSERT INTO inventory_balances (yard, commodity, qty, avg_cost) VALUES ($1,$2,0,$3)
         ON CONFLICT (yard, commodity) DO NOTHING`,
        [y.code, c.code, c.masterPrice]
      );
    }
  }

  const vendorRows = await Promise.all([
    query(`INSERT INTO vendors (name, phone, tier, notes) VALUES ('Platte Valley Salvage','308-555-0142','d1','') RETURNING id`),
    // Same phone number under a near-identical name — kept intentionally, mirrors the prototype's
    // Exceptions-report demo duplicate-vendor scenario (Reports → Exceptions in the HTML prototype).
    query(`INSERT INTO vendors (name, phone, tier, notes) VALUES ('Dale Hendricks','308-555-0198','scale','Walk-in regular') RETURNING id`),
    query(`INSERT INTO vendors (name, phone, tier, notes) VALUES ('Dale Hendrix','308-555-0198','scale','') RETURNING id`),
  ]);
  const [pvs, hendricks, hendrix] = vendorRows.map((r) => r.rows[0].id);

  const customerRows = await Promise.all([
    query(`INSERT INTO customers (name, tier, freight_per_lb, terms, business_exempt) VALUES ('Nucor Steel Kingman','dh',0.018,'net30',true) RETURNING id`),
    query(`INSERT INTO customers (name, tier, freight_per_lb, terms, business_exempt) VALUES ('Interstate Recycling Co.','d1',0.022,'net15',true) RETURNING id`),
  ]);
  const [nucor, interstate] = customerRows.map((r) => r.rows[0].id);

  await query(`INSERT INTO carriers (name, phone, mc, type) VALUES ('Redline Trucking','308-555-0110','MC-482910','common') ON CONFLICT DO NOTHING`);

  await query(
    `INSERT INTO contracts (id, customer_id, commodity, yard, committed_qty, end_date, notes) VALUES
     ('CT-1001',$1,'HMS1','SB',200000,'2026-09-15','3 railcars, Nucor Kingman spur')
     ON CONFLICT (id) DO NOTHING`,
    [nucor]
  );
  await query(
    `INSERT INTO purchase_orders (id, vendor_id, commodity, yard, committed_qty, end_date, notes) VALUES
     ('PO-1001',$1,'HMS1','SB',100000,'2026-09-20','Standing weekly pickup')
     ON CONFLICT (id) DO NOTHING`,
    [pvs]
  );

  // A few demo tickets posted through the same transactional path the API uses, so on-hand/avg
  // cost reflect real posted history rather than being hand-set.
  const demoTickets = [
    { type: "buy", date: "2026-08-17", yard: "SB", vendorId: pvs, partyName: "Platte Valley Salvage", commodity: "HMS1", netWeight: 12400, price: 0.106, payment: "Check" },
    { type: "buy", date: "2026-08-18", yard: "SB", vendorId: hendricks, partyName: "Dale Hendricks", commodity: "CU-1", tier: "scale", netWeight: 210, price: 3.575, payment: "Check" },
    { type: "buy", date: "2026-08-18", yard: "RC", vendorId: hendricks, partyName: "Dale Hendricks", commodity: "CU-BB", tier: "scale", netWeight: 150, price: 3.975, payment: "ACH" },
    { type: "buy", date: "2026-08-16", yard: "SB", vendorId: hendrix, partyName: "Dale Hendrix", commodity: "CU-1", tier: "scale", netWeight: 180, price: 3.575, payment: "Check" },
    { type: "sell", date: "2026-08-17", yard: "SB", customerId: nucor, partyName: "Nucor Steel Kingman", commodity: "HMS1", netWeight: 44000, price: 0.098, payment: "ACH" },
  ];

  for (const t of demoTickets) {
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
    await query("UPDATE inventory_balances SET qty = $3, avg_cost = $4 WHERE yard = $1 AND commodity = $2", [t.yard, t.commodity, newQty, newAvgCost]);
    const total = Math.round(t.netWeight * t.price * 100) / 100;
    await query(
      `INSERT INTO tickets (id, type, date, yard, vendor_id, customer_id, party_name, commodity, tier, net_weight, price, total, payment, status, cogs_per_lb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, t.type, t.date, t.yard, t.vendorId || null, t.customerId || null, t.partyName, t.commodity, t.tier || null, t.netWeight, t.price, total, t.payment, t.type === "buy" ? "Closed" : null, cogsPerLb]
    );
    await query(
      `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.yard, t.commodity, ledgerType, t.type === "buy" ? t.netWeight : -t.netWeight, t.type === "buy" ? t.price : null, newQty, newAvgCost, Math.round(newQty * newAvgCost * 100) / 100, id, t.date]
    );
  }

  console.log("Seed complete.");
  console.log(`Login: andy.bush@langerindustrial.com / changeme123 (change this before any real deploy)`);
}

main()
  .catch((err) => { console.error("Seed failed:", err); process.exitCode = 1; })
  .finally(() => pool.end());
