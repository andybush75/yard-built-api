// End-to-end smoke test against a running server (npm run dev) + seeded database (npm run seed).
// Exercises: login/auth, commodities read, vendor duplicate-phone data, ticket creation with real
// inventory posting (buy then sell, checking moving-average cost and ledger), and a remittance run.
const BASE = process.env.BASE_URL || "http://localhost:4000";

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("OK  " + msg);
}

async function main() {
  const health = await req("GET", "/health");
  assert(health.status === 200 && health.body.ok, "health check responds");

  const noAuth = await req("GET", "/commodities");
  assert(noAuth.status === 401, "commodities list rejects unauthenticated requests");

  const login = await req("POST", "/auth/login", { body: { email: "andy.bush@langerindustrial.com", password: "changeme123" } });
  assert(login.status === 200 && login.body.token, "login succeeds and returns a token");
  const token = login.body.token;

  const me = await req("GET", "/auth/me", { token });
  assert(me.status === 200 && me.body.role === "Admin", "me reflects the Admin role");

  const commodities = await req("GET", "/commodities", { token });
  assert(commodities.status === 200 && commodities.body.length >= 6, "commodities list is seeded");

  const vendors = await req("GET", "/vendors", { token });
  const hendricks = vendors.body.find((v) => v.name === "Dale Hendricks");
  const hendrix = vendors.body.find((v) => v.name === "Dale Hendrix");
  assert(hendricks && hendrix && hendricks.phone === hendrix.phone, "duplicate-vendor demo pair (same phone) is present, like the prototype's Exceptions report");

  const balBefore = await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token });
  const qtyBefore = balBefore.body.length ? parseFloat(balBefore.body[0].qty) : 0;

  const buy = await req("POST", "/tickets", {
    token,
    body: { type: "buy", date: "2026-10-02", yard: "COLBY", holdDesc: "Smoke-test walk-in", partyName: "Smoke Test Walk-in", commodity: "HMS2", netWeight: 1000, price: 0.09, payment: "Check" },
  });
  assert(buy.status === 201 && buy.body.id, "buy ticket created: " + JSON.stringify(buy.body));
  assert(parseFloat(buy.body.total) === 90, "buy ticket total computed correctly (1000 * 0.09 = 90)");

  const balAfterBuy = await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token });
  const qtyAfterBuy = parseFloat(balAfterBuy.body[0].qty);
  assert(Math.abs(qtyAfterBuy - (qtyBefore + 1000)) < 0.001, `on-hand qty increased by exactly the buy weight (${qtyBefore} -> ${qtyAfterBuy})`);

  const sell = await req("POST", "/tickets", {
    token,
    body: { type: "sell", date: "2026-10-02", yard: "COLBY", partyName: "Interstate Recycling Co.", commodity: "HMS2", netWeight: 400, price: 0.12, payment: "ACH" },
  });
  assert(sell.status === 201, "sell ticket created: " + JSON.stringify(sell.body));
  assert(sell.body.cogs_per_lb !== null, "sell ticket snapshots cogs_per_lb from the moving average at time of sale");

  const balAfterSell = await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token });
  const qtyAfterSell = parseFloat(balAfterSell.body[0].qty);
  assert(Math.abs(qtyAfterSell - (qtyAfterBuy - 400)) < 0.001, `on-hand qty decreased by exactly the sell weight (${qtyAfterBuy} -> ${qtyAfterSell})`);

  const ledger = await req("GET", "/inventory/ledger?yard=COLBY&commodity=HMS2&limit=5", { token });
  assert(ledger.status === 200 && ledger.body.length >= 2, "ledger has entries for both postings");
  assert(ledger.body[0].ref === sell.body.id, "most recent ledger entry references the sell ticket just posted");

  // Vendor-linked buy: vendor_id is stored and the vendor's name is snapshotted when none is sent.
  const linked = await req("POST", "/tickets", {
    token,
    body: { type: "buy", date: "2026-10-02", yard: "COLBY", vendorId: hendricks.id, commodity: "HMS2", netWeight: 50, price: 0.09, payment: "Check" },
  });
  assert(linked.status === 201 && linked.body.vendor_id === hendricks.id, "buy ticket stores vendor_id when a vendor is picked");
  assert(linked.body.party_name === "Dale Hendricks", "party_name is snapshotted from the vendor record");
  const badLink = await req("POST", "/tickets", {
    token,
    body: { type: "buy", date: "2026-10-02", yard: "COLBY", vendorId: "not-a-real-id", partyName: "x", commodity: "HMS2", netWeight: 50, price: 0.09, payment: "Check" },
  });
  assert(badLink.status === 400, "a vendorId that doesn't exist is rejected with 400");

  const newVendor = await req("POST", "/vendors", { token, body: { name: "Smoke Test Dealer", phone: "308-555-0100", tier: "d2" } });
  assert(newVendor.status === 201 && newVendor.body.id && newVendor.body.tier === "d2", "vendor can be created through the API");
  const patched = await req("PATCH", `/vendors/${newVendor.body.id}`, { token, body: { smartphone: true, autoSend: "daily" } });
  assert(patched.status === 200 && patched.body.smartphone === true && patched.body.auto_send === "daily", "vendor fields can be updated through the API");

  // A duplicate ticket id must be rejected, not silently overwritten — proves the real constraint
  // the in-memory prototype could never enforce.
  const dupe = await req("POST", "/tickets", { token, body: { id: buy.body.id, type: "buy", date: "2026-10-02", yard: "COLBY", partyName: "x", commodity: "HMS2", netWeight: 1, price: 0.01, payment: "Check" } });
  assert(dupe.status === 409, "duplicate ticket id is rejected with 409, not silently accepted");

  const remit = await req("POST", "/remittances", {
    token,
    body: { payee: "Smoke Test Walk-in", method: "Check", account: "COLBY", date: "2026-10-02", ticketIds: [buy.body.id] },
  });
  assert(remit.status === 201 && Math.abs(parseFloat(remit.body.total) - 90) < 0.001, "remittance created covering the buy ticket");

  const doublePay = await req("POST", "/remittances", {
    token,
    body: { payee: "Smoke Test Walk-in", method: "Check", account: "COLBY", date: "2026-10-02", ticketIds: [buy.body.id] },
  });
  assert(doublePay.status === 409, "a second remittance on an already-paid ticket is rejected");

  const voided = await req("POST", `/remittances/${remit.body.id}/void`, { token });
  assert(voided.status === 200 && voided.body.voided === true, "remittance can be voided");
  const ticketAfterVoid = await req("GET", `/tickets/${buy.body.id}`, { token });
  assert(ticketAfterVoid.body.paid === false && ticketAfterVoid.body.remittance_id === null, "voiding re-opens the ticket for payment");
  const doubleVoid = await req("POST", `/remittances/${remit.body.id}/void`, { token });
  assert(doubleVoid.status === 409, "voiding the same remittance twice is rejected");

  // Permission enforcement: a scale operator can post tickets but cannot cut checks or touch bank
  // accounts. Uses the demo-only operator seeded by db/seed.js.
  const opLogin = await req("POST", "/auth/login", { body: { email: "scale.demo@example.com", password: "changeme123" } });
  assert(opLogin.status === 200 && opLogin.body.user.role === "Scale Operator", "demo scale operator can log in");
  const opToken = opLogin.body.token;
  const opRemit = await req("POST", "/remittances", {
    token: opToken,
    body: { payee: "Smoke Test Walk-in", method: "Check", account: "COLBY", date: "2026-10-02", ticketIds: [buy.body.id] },
  });
  assert(opRemit.status === 403, "scale operator is denied creating a remittance (403)");
  const opVoid = await req("POST", `/remittances/${remit.body.id}/void`, { token: opToken });
  assert(opVoid.status === 403, "scale operator is denied voiding a remittance (403)");
  const opBank = await req("PATCH", "/bank-accounts/COLBY", { token: opToken, body: { startingBalance: 1 } });
  assert(opBank.status === 403, "scale operator is denied editing a bank account (403)");
  const opTicket = await req("POST", "/tickets", {
    token: opToken,
    body: { type: "buy", date: "2026-10-02", yard: "COLBY", partyName: "Operator smoke walk-in", commodity: "HMS2", netWeight: 10, price: 0.09, payment: "Check" },
  });
  assert(opTicket.status === 201, "scale operator can still post a ticket");

  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
