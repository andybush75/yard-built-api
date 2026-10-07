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

  // ---- Hold → Cashier → Pay workflow ----
  assert(buy.body.status === "Held", "a new buy ticket posts as Held (waits at the cashier)");
  assert(sell.body.status === "Closed", "a new sell ticket posts as Closed");
  const cash = await req("POST", "/tickets", { token, body: { type: "buy", date: "2026-10-02", yard: "COLBY", partyName: "x", commodity: "HMS2", netWeight: 1, price: 0.01, payment: "Cash" } });
  assert(cash.status === 400, "Cash is not an accepted payment method (Check/ACH only)");

  // `buy` is a walk-in: it was paid on `remit`, then that remittance was voided, so it is now
  // Closed and unpaid. Paying it again through the cashier route needs a typed payee.
  const noPayee = await req("POST", `/tickets/${buy.body.id}/pay`, { token, body: { method: "Check", date: "2026-10-02" } });
  assert(noPayee.status === 400, "paying a walk-in without a payee name is rejected");
  const walkPay = await req("POST", `/tickets/${buy.body.id}/pay`, { token, body: { method: "Check", payee: "Walk-in Joe", date: "2026-10-02" } });
  assert(walkPay.status === 200 && walkPay.body.ticket.paid === true && walkPay.body.ticket.status === "Closed", "cashier Pay closes and pays the ticket in one step");
  assert(walkPay.body.remittance.payee === "Walk-in Joe" && walkPay.body.remittance.check_number, "Pay cut a one-line check to the typed payee with an auto-assigned number");
  const firstCheck = parseInt(walkPay.body.remittance.check_number, 10);
  assert(parseInt(remit.body.check_number, 10) + 1 === firstCheck, `check numbers are sequential per account (${remit.body.check_number} then ${firstCheck})`);
  const dupCheck = await req("POST", `/tickets/${linked.body.id}/pay`, { token, body: { method: "Check", checkNumber: String(firstCheck), date: "2026-10-02" } });
  assert(dupCheck.status === 409, "a typed check number already used on that account is rejected");

  // `linked` has a dealer record and is Held: Pay Later sends it to AP unpaid.
  const payLater = await req("POST", `/tickets/${linked.body.id}/pay-later`, { token });
  assert(payLater.status === 200 && payLater.body.status === "Closed" && payLater.body.paid === false && payLater.body.closed_by === me.body.id, "Pay Later closes a held dealer ticket unpaid and records who did it");
  const payLaterAgain = await req("POST", `/tickets/${linked.body.id}/pay-later`, { token });
  assert(payLaterAgain.status === 409, "Pay Later on a ticket that is no longer Held is rejected");
  const walkHeld = await req("POST", "/tickets", { token, body: { type: "buy", date: "2026-10-02", yard: "COLBY", partyName: "Smoke walk-in 2", holdDesc: "red F-150", commodity: "HMS2", netWeight: 20, price: 0.09, payment: "Check" } });
  const walkLater = await req("POST", `/tickets/${walkHeld.body.id}/pay-later`, { token });
  assert(walkLater.status === 409, "Pay Later on a walk-in is refused (walk-ins are excluded from AP)");

  // Ticket page: timeline with names.
  const page = await req("GET", `/tickets/${buy.body.id}`, { token });
  const actions = page.body.timeline.map((e) => e.action);
  assert(page.status === 200 && actions[0] === "ticket.create" && actions.includes("ticket.pay") && actions.includes("ticket.unpay"), "ticket page carries a timeline: " + actions.join(" → "));
  assert(page.body.timeline.every((e) => e.user_name === "Andy Bush"), "timeline entries name who did them");
  assert(page.body.remittance && page.body.remittance.id === walkPay.body.remittance.id, "ticket page includes the remittance it was paid on");

  // Void: paid tickets can't be voided; unpaid ones reverse inventory.
  const voidPaid = await req("POST", `/tickets/${buy.body.id}/void`, { token, body: { reason: "test" } });
  assert(voidPaid.status === 409, "a paid ticket can't be voided until its remittance is voided");
  const balBeforeVoid = parseFloat((await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token })).body[0].qty);
  const noReason = await req("POST", `/tickets/${walkHeld.body.id}/void`, { token, body: {} });
  assert(noReason.status === 400, "voiding needs a reason");
  const voidOk = await req("POST", `/tickets/${walkHeld.body.id}/void`, { token, body: { reason: "Weighed wrong truck" } });
  assert(voidOk.status === 200 && voidOk.body.status === "Voided" && voidOk.body.void_reason === "Weighed wrong truck", "an unpaid ticket can be voided with a reason");
  const balAfterVoid = parseFloat((await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token })).body[0].qty);
  assert(Math.abs(balAfterVoid - (balBeforeVoid - 20)) < 0.001, "voiding a buy takes its weight back out of inventory");
  const voidTwice = await req("POST", `/tickets/${walkHeld.body.id}/void`, { token, body: { reason: "again" } });
  assert(voidTwice.status === 409, "a ticket can't be voided twice");
  const payVoided = await req("POST", `/tickets/${walkHeld.body.id}/pay`, { token, body: { method: "ACH", payee: "x", date: "2026-10-02" } });
  assert(payVoided.status === 409, "a voided ticket can't be paid");

  // Check-register flags and search.
  const flags = await req("PATCH", `/remittances/${walkPay.body.remittance.id}`, { token, body: { checkPrinted: true, cleared: true, clearedDate: "2026-10-05" } });
  assert(flags.status === 200 && flags.body.check_printed === true && flags.body.cleared === true && String(flags.body.cleared_date).startsWith("2026-10-05"), "check-register flags can be set on a remittance");
  const heldList = await req("GET", "/tickets?status=Held&yard=COLBY", { token });
  assert(heldList.status === 200 && heldList.body.every((t) => t.status === "Held" && t.yard === "COLBY"), "tickets can be listed by status (the cashier queue)");
  const search = await req("GET", "/search?q=red%20F-150", { token });
  assert(search.status === 200 && search.body.tickets.some((t) => t.id === walkHeld.body.id), "search finds a ticket by its hold description");
  const searchCheck = await req("GET", `/search?q=${firstCheck}`, { token });
  assert(searchCheck.body.remittances.some((r) => r.id === walkPay.body.remittance.id), "search finds a check by its number");
  const searchVendor = await req("GET", "/search?q=308-555-0198", { token });
  assert(searchVendor.body.vendors.length >= 2, "search finds dealers by phone number");
  const setNext = await req("PATCH", "/bank-accounts/COLBY", { token, body: { nextCheckNumber: 5000 } });
  assert(setNext.status === 200 && setNext.body.next_check_number === 5000, "admin can set the next check number for an account");
  const afterSet = await req("POST", `/tickets/${linked.body.id}/pay`, { token, body: { method: "Check", date: "2026-10-02" } });
  assert(afterSet.status === 200 && afterSet.body.remittance.check_number === "5000", "the next check uses the newly set number");

  // ---- Freight ----
  const carriersList = await req("GET", "/carriers", { token });
  const redline = carriersList.body.find((c) => c.name === "Redline Trucking");
  assert(!!redline, "seeded carrier is present");
  const lane = await req("POST", "/lanes", { token, body: { origin: "Colby, KS", destination: "Regional Mill - Wichita", carrierId: redline.id, rateBasis: "flat", rate: 650 } });
  assert(lane.status === 201 && lane.body.rate_basis === "flat", "a lane can be created");
  const badLane = await req("POST", "/lanes", { token, body: { origin: "x", destination: "y", rateBasis: "per_banana" } });
  assert(badLane.status === 400, "an unknown rate basis is rejected");

  // Inbound freight on a buy capitalizes into the yard's average cost; a placeholder adds $0.01 now
  // and the rest when reconciled.
  const fbuy = await req("POST", "/tickets", { token, body: { type: "buy", date: "2026-10-02", yard: "COLBY", vendorId: hendricks.id, commodity: "HMS1", netWeight: 10000, price: 0.10, payment: "Check" } });
  assert(fbuy.status === 201, "buy ticket for freight test created");
  const avgBefore = parseFloat((await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS1", { token })).body[0].avg_cost);
  const fr = await req("POST", "/freight", { token, body: { ticketId: fbuy.body.id, carrierId: redline.id, laneId: lane.body.id, origin: "Dealer lot", destination: "Colby yard", placeholder: true } });
  assert(fr.status === 201 && fr.body.freight.status === "Estimated" && parseFloat(fr.body.freight.cost) === 0.01, "placeholder freight attaches as Estimated at $0.01");
  const dupeFreight = await req("POST", "/freight", { token, body: { ticketId: fbuy.body.id, carrierId: redline.id, cost: 100 } });
  assert(dupeFreight.status === 409, "a second freight ticket on the same scale ticket is refused");
  const payPlaceholder = await req("POST", "/remittances", { token, body: { payee: "Redline Trucking", method: "ACH", account: "COLBY", date: "2026-10-02", freightIds: [fr.body.freight.id] } });
  assert(payPlaceholder.status === 409, "a placeholder freight ticket can't be paid until reconciled");
  const rec = await req("POST", `/freight/${fr.body.freight.id}/reconcile`, { token, body: { cost: 500 } });
  assert(rec.status === 200 && rec.body.freight.status === "Reconciled" && parseFloat(rec.body.freight.capitalized_amount) === 500, "reconciling sets the real cost and capitalizes it");
  assert(rec.body.ledgerEntry && rec.body.ledgerEntry.type === "Freight-in", "capitalization writes a Freight-in ledger entry");
  const balHMS1 = (await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS1", { token })).body[0];
  const expectedAvg = avgBefore + 500 / parseFloat(balHMS1.qty);
  assert(Math.abs(parseFloat(balHMS1.avg_cost) - expectedAvg) < 0.00005, `inbound freight raised the average cost by freight ÷ on-hand qty (${avgBefore} -> ${balHMS1.avg_cost})`);

  // Outbound freight on a sell is an AP cost only — average cost doesn't move.
  const avgSellBefore = parseFloat((await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token })).body[0].avg_cost);
  const frOut = await req("POST", "/freight", { token, body: { ticketId: sell.body.id, carrierId: redline.id, origin: "Colby yard", destination: "Interstate", cost: 300 } });
  assert(frOut.status === 201 && parseFloat(frOut.body.freight.capitalized_amount) === 0 && frOut.body.ledgerEntry === null, "outbound freight is not capitalized");
  const avgSellAfter = parseFloat((await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS2", { token })).body[0].avg_cost);
  assert(avgSellAfter === avgSellBefore, "outbound freight leaves the average cost unchanged");

  // One check covers a dealer's material and the carrier's freight (payee is just a name).
  const combo = await req("POST", "/remittances", { token, body: { payee: "Redline Trucking", method: "Check", account: "COLBY", date: "2026-10-02", ticketIds: [fbuy.body.id], freightIds: [fr.body.freight.id, frOut.body.freight.id] } });
  assert(combo.status === 201 && combo.body.lines.length === 3 && Math.abs(parseFloat(combo.body.total) - (1000 + 500 + 300)) < 0.001, "one remittance can combine ticket and freight lines");
  const frPaid = await req("GET", `/freight/${fr.body.freight.id}`, { token });
  assert(frPaid.body.paid === true && frPaid.body.remittance_id === combo.body.id, "freight is marked paid with its remittance");
  const voidPaidFreight = await req("POST", `/freight/${fr.body.freight.id}/void`, { token, body: { reason: "x" } });
  assert(voidPaidFreight.status === 409, "paid freight can't be voided until the remittance is");
  const voidCombo = await req("POST", `/remittances/${combo.body.id}/void`, { token, body: { reason: "test" } });
  assert(voidCombo.status === 200, "combined remittance can be voided");
  const frUnpaid = await req("GET", `/freight/${fr.body.freight.id}`, { token });
  assert(frUnpaid.body.paid === false && frUnpaid.body.remittance_id === null, "voiding the remittance re-opens the freight");
  const voidFreightOk = await req("POST", `/freight/${fr.body.freight.id}/void`, { token, body: { reason: "wrong load" } });
  assert(voidFreightOk.status === 200 && voidFreightOk.body.freight.voided_at && voidFreightOk.body.ledgerEntry, "voiding capitalized freight reverses the cost with a ledger entry");
  const avgAfterVoid = parseFloat((await req("GET", "/inventory/balances?yard=COLBY&commodity=HMS1", { token })).body[0].avg_cost);
  assert(Math.abs(avgAfterVoid - avgBefore) < 0.00005, "average cost is back where it started after the void");
  const reattach = await req("POST", "/freight", { token, body: { ticketId: fbuy.body.id, carrierId: redline.id, cost: 450 } });
  assert(reattach.status === 201, "freight can be re-attached after a void");
  const pageWithFreight = await req("GET", `/tickets/${fbuy.body.id}`, { token });
  assert(pageWithFreight.body.freight && pageWithFreight.body.freight.id === reattach.body.freight.id, "ticket page carries its live freight ticket");
  assert(pageWithFreight.body.timeline.some((e) => e.action === "ticket.freight_attach") && pageWithFreight.body.timeline.some((e) => e.action === "ticket.freight_void"), "freight events show on the ticket timeline");

  // ---- Trailers ----
  const settings = await req("GET", "/settings", { token });
  assert(settings.status === 200 && settings.body.trailer_loads_goal_per_week === 5 && settings.body.trailer_tons_target_by_type["End dump"] === 60, "trailer targets come from app settings");
  const tnum = String(900 + (stamp % 90));
  const trailer = await req("POST", "/trailers", { token, body: { number: tnum, yard: "COLBY", type: "End dump", carrierId: redline.id } });
  assert(trailer.status === 201 && trailer.body.carrier_name === "Redline Trucking", "a trailer can be created with its current carrier");
  const badType = await req("POST", "/trailers", { token, body: { number: tnum + "x", yard: "COLBY", type: "Hovercraft" } });
  assert(badType.status === 400, "an unknown trailer type is rejected");
  const dupeTrailer = await req("POST", "/trailers", { token, body: { number: tnum, yard: "COLBY" } });
  assert(dupeTrailer.status === 409, "duplicate trailer number is rejected");
  const sellOnTrailer = await req("POST", "/tickets", { token, body: { type: "sell", date: "2026-10-02", yard: "COLBY", partyName: "Interstate Recycling Co.", commodity: "HMS2", netWeight: 40000, price: 0.12, payment: "ACH", shipmentId: null, trailerId: trailer.body.id } });
  assert(sellOnTrailer.status === 201 && sellOnTrailer.body.trailer_id === trailer.body.id, "a sell ticket records the trailer that hauled it");
  const badTrailer = await req("POST", "/tickets", { token, body: { type: "sell", date: "2026-10-02", yard: "COLBY", partyName: "x", commodity: "HMS2", netWeight: 10, price: 0.12, payment: "ACH", trailerId: "nope" } });
  assert(badTrailer.status === 400, "an unknown trailerId on a ticket is rejected");
  const buyOnTrailer = await req("POST", "/tickets", { token, body: { type: "buy", date: "2026-10-02", yard: "COLBY", vendorId: hendricks.id, commodity: "HMS2", netWeight: 10000, price: 0.09, payment: "Check" } });
  const setTrailer = await req("PATCH", `/tickets/${buyOnTrailer.body.id}/trailer`, { token, body: { trailerId: trailer.body.id } });
  assert(setTrailer.status === 200 && setTrailer.body.trailer_id === trailer.body.id, "the trailer can be set on a ticket after the fact");
  // 2026-10-02 is a Friday; its Sun–Sat week starts 2026-09-27. Ask for utilization as of that Friday.
  const util = await req("GET", "/trailers/utilization?weeks=4&asOf=2026-10-02", { token });
  assert(util.status === 200 && util.body.weeks.length === 4 && util.body.weeks[3].start === "2026-09-27", "utilization returns Sun–Sat weeks ending with the current week");
  const u = util.body.trailers.find((t) => t.id === trailer.body.id);
  assert(u && u.outLoads[3] === 1 && Math.abs(u.outTons[3] - 20) < 0.01, `outbound: 1 load, 20.0 tons this week (${JSON.stringify(u && u.outTons)})`);
  assert(u.inLoads[3] === 1 && Math.abs(u.inTons[3] - 5) < 0.01, "inbound: 1 load, 5.0 tons this week");
  assert(u.target === 60 && u.daysSinceOut === 0, "End dump target is 60 and days-since-out is 0 on the day of the load");
  const hist = await req("POST", "/trailers/import-history", { token, body: { rows: [
    { number: tnum, yard: "COLBY", type: "End dump", weekStart: "2026-09-20", outLoads: 3, outTons: 61.5, inLoads: 0, inTons: 0 },
    { number: tnum + "-new", yard: "HAYS", type: "Gondola", carrierName: "Smoke Carrier " + stamp, weekStart: "2026-09-20", outLoads: 1, outTons: 20, inLoads: 0, inTons: 0 },
  ] } });
  assert(hist.status === 200 && hist.body.trailersCreated === 1 && hist.body.weeksWritten === 2, "history import writes weeks and creates unknown trailers (and their carrier)");
  const util2 = await req("GET", "/trailers/utilization?weeks=4&asOf=2026-10-02", { token });
  const u2 = util2.body.trailers.find((t) => t.id === trailer.body.id);
  assert(Math.abs(u2.outTons[2] - 61.5) < 0.01 && u2.outLoads[2] === 3, "imported history fills weeks that have no tickets");
  const opHist = await req("POST", "/trailers/import-history", { token: opToken, body: { rows: [] } });
  assert(opHist.status === 403, "scale operator can't import history");
  const deactTrailer = await req("PATCH", `/trailers/${trailer.body.id}`, { token, body: { active: false, carrierId: "" } });
  assert(deactTrailer.status === 200 && deactTrailer.body.active === false && deactTrailer.body.carrier_id === null, "a trailer can be deactivated and its carrier cleared");

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
