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

  // ---- User & role management ----
  const rolesList = await req("GET", "/roles", { token: opToken });
  assert(rolesList.status === 200 && rolesList.body.some((r) => r.name === "Admin"), "any user can read the role list");
  const cashierRole = rolesList.body.find((r) => r.name === "Cashier");
  const adminRole = rolesList.body.find((r) => r.name === "Admin");

  const opAdd = await req("POST", "/users", { token: opToken, body: { name: "x", email: "x@example.com", password: "password123", roleId: cashierRole.id } });
  assert(opAdd.status === 403, "scale operator is denied creating a user (403)");

  const stamp = Date.now();
  const newUser = await req("POST", "/users", { token, body: { name: "Smoke Cashier", email: `smoke.cashier.${stamp}@example.com`, password: "temp-pass-123", roleId: cashierRole.id } });
  assert(newUser.status === 201 && newUser.body.role_name === "Cashier" && newUser.body.password_hash === undefined, "admin can create a user; password hash is never returned");
  const shortPw = await req("POST", "/users", { token, body: { name: "y", email: `y.${stamp}@example.com`, password: "short", roleId: cashierRole.id } });
  assert(shortPw.status === 400, "a password under 8 characters is rejected");
  const dupeEmail = await req("POST", "/users", { token, body: { name: "Smoke Cashier", email: `smoke.cashier.${stamp}@example.com`, password: "temp-pass-123", roleId: cashierRole.id } });
  assert(dupeEmail.status === 409, "duplicate email is rejected with 409");

  const newLogin = await req("POST", "/auth/login", { body: { email: `SMOKE.CASHIER.${stamp}@example.com`, password: "temp-pass-123" } });
  assert(newLogin.status === 200 && newLogin.body.user.role === "Cashier", "new user can log in (email case-insensitive)");
  const badChange = await req("POST", "/auth/change-password", { token: newLogin.body.token, body: { currentPassword: "wrong", newPassword: "another-pass-123" } });
  assert(badChange.status === 401, "changing password with the wrong current password is rejected");
  const goodChange = await req("POST", "/auth/change-password", { token: newLogin.body.token, body: { currentPassword: "temp-pass-123", newPassword: "another-pass-123" } });
  assert(goodChange.status === 200, "user can change their own password");
  const reLogin = await req("POST", "/auth/login", { body: { email: `smoke.cashier.${stamp}@example.com`, password: "another-pass-123" } });
  assert(reLogin.status === 200, "new password works for login");

  const grant = await req("PATCH", `/users/${newUser.body.id}`, { token, body: { grants: ["editPricing"] } });
  assert(grant.status === 200 && grant.body.grants.includes("editPricing"), "admin can grant an individual permission");
  const badKey = await req("PATCH", `/users/${newUser.body.id}`, { token, body: { grants: ["notAPermission"] } });
  assert(badKey.status === 400, "an unknown permission key is rejected");
  const selfChange = await req("PATCH", `/users/${me.body.id}`, { token, body: { roleId: cashierRole.id } });
  assert(selfChange.status === 400, "you can't change your own role");
  const deact = await req("PATCH", `/users/${newUser.body.id}`, { token, body: { active: false } });
  assert(deact.status === 200 && deact.body.active === false, "admin can deactivate a user");
  const deactLogin = await req("POST", "/auth/login", { body: { email: `smoke.cashier.${stamp}@example.com`, password: "another-pass-123" } });
  assert(deactLogin.status === 401, "a deactivated user can't log in");
  const deactToken = await req("GET", "/auth/me", { token: reLogin.body.token });
  assert(deactToken.status === 401, "a deactivated user's existing token stops working");

  const newRole = await req("POST", "/roles", { token, body: { name: `Smoke Role ${stamp}`, permissions: ["packInventory"] } });
  assert(newRole.status === 201 && newRole.body.system === false, "admin can create a custom role");
  const editRole = await req("PATCH", `/roles/${newRole.body.id}`, { token, body: { permissions: ["packInventory", "voidTickets"] } });
  assert(editRole.status === 200 && editRole.body.permissions.length === 2, "custom role permissions can be changed");
  const editSystem = await req("PATCH", `/roles/${adminRole.id}`, { token, body: { permissions: [] } });
  assert(editSystem.status === 400, "built-in role permissions can't be changed");
  const delSystem = await req("DELETE", `/roles/${adminRole.id}`, { token });
  assert(delSystem.status === 400, "built-in roles can't be deleted");
  const assignRole = await req("PATCH", `/users/${newUser.body.id}`, { token, body: { roleId: newRole.body.id } });
  assert(assignRole.status === 200, "user can be moved onto the custom role");
  const delInUse = await req("DELETE", `/roles/${newRole.body.id}`, { token });
  assert(delInUse.status === 409, "a role with users on it can't be deleted");
  await req("PATCH", `/users/${newUser.body.id}`, { token, body: { roleId: cashierRole.id } });
  const delRole = await req("DELETE", `/roles/${newRole.body.id}`, { token });
  assert(delRole.status === 204, "an unused custom role can be deleted");

  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
