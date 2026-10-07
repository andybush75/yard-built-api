const express = require("express");
const { pool, query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { yard, type, commodity, limit } = req.query;
  const clauses = [];
  const params = [];
  if (yard) { params.push(yard); clauses.push(`yard = $${params.length}`); }
  if (type) { params.push(type); clauses.push(`type = $${params.length}`); }
  if (commodity) { params.push(commodity); clauses.push(`commodity = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(parseInt(limit, 10) || 200, 1000));
  const { rows } = await query(
    `SELECT * FROM tickets ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM tickets WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

function nowTimeLabel() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// The one route that matters most for "real backend + database": creating a ticket and posting
// its effect on inventory happens inside a single DB transaction with the inventory row locked
// (SELECT ... FOR UPDATE), so two scale operators posting tickets for the same yard/commodity at
// the same moment can never race each other into a wrong moving-average cost — the exact class of
// bug the in-memory prototype can't prevent once more than one person uses it at once.
router.post("/", requireAuth, async (req, res) => {
  const {
    id, type, date, yard, vendorId, customerId, partyName, holdDesc,
    commodity, tier, netWeight, price, payment, contractId, poId, shipmentId,
  } = req.body || {};

  if (!type || !["buy", "sell"].includes(type)) return res.status(400).json({ error: "type must be 'buy' or 'sell'" });
  if (!date || !yard || !commodity || !netWeight || price === undefined || !payment) {
    return res.status(400).json({ error: "date, yard, commodity, netWeight, price, and payment are required" });
  }
  if (!partyName && !vendorId && !customerId) {
    return res.status(400).json({ error: "vendorId, customerId, or a Walk-in partyName/holdDesc is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // A linked vendor/customer must be a real row. Its name is snapshotted onto the ticket when the
    // caller didn't send one, so a ticket always carries a party_name even if the record is renamed.
    let snapshotName = partyName || null;
    if (vendorId) {
      const { rows } = await client.query("SELECT name FROM vendors WHERE id = $1", [vendorId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "vendorId does not match any vendor" }); }
      snapshotName = snapshotName || rows[0].name;
    }
    if (customerId) {
      const { rows } = await client.query("SELECT name FROM customers WHERE id = $1", [customerId]);
      if (!rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "customerId does not match any customer" }); }
      snapshotName = snapshotName || rows[0].name;
    }

    let ticketId = id;
    if (!ticketId) {
      const seqName = type === "buy" ? "ticket_buy_seq" : "ticket_sell_seq";
      const prefix = type === "buy" ? "B" : "S";
      const { rows: seqRows } = await client.query(`SELECT nextval($1) AS n`, [seqName]);
      ticketId = `${prefix}-${seqRows[0].n}`;
    }

    const { rows: existing } = await client.query("SELECT 1 FROM inventory_balances WHERE yard = $1 AND commodity = $2 FOR UPDATE", [yard, commodity]);
    let inv;
    if (!existing.length) {
      const { rows } = await client.query(
        "INSERT INTO inventory_balances (yard, commodity, qty, avg_cost) VALUES ($1,$2,0,0) RETURNING *",
        [yard, commodity]
      );
      inv = rows[0];
    } else {
      const { rows } = await client.query("SELECT * FROM inventory_balances WHERE yard = $1 AND commodity = $2", [yard, commodity]);
      inv = rows[0];
    }

    const qty = parseFloat(inv.qty);
    const avgCost = parseFloat(inv.avg_cost);
    const netWeightNum = parseFloat(netWeight);
    const priceNum = parseFloat(price);
    let newQty, newAvgCost, cogsPerLb = null, ledgerType;

    if (type === "buy") {
      newQty = qty + netWeightNum;
      newAvgCost = newQty > 0 ? (qty * avgCost + netWeightNum * priceNum) / newQty : priceNum;
      ledgerType = "Buy";
    } else {
      newQty = qty - netWeightNum; // intentionally allowed to go negative — see the prototype's negative-inventory handling
      newAvgCost = avgCost;
      cogsPerLb = avgCost;
      ledgerType = "Sell";
    }

    await client.query(
      "UPDATE inventory_balances SET qty = $3, avg_cost = $4, updated_at = now() WHERE yard = $1 AND commodity = $2",
      [yard, commodity, newQty, newAvgCost]
    );

    const total = Math.round(netWeightNum * priceNum * 100) / 100;

    const { rows: ticketRows } = await client.query(
      `INSERT INTO tickets (id, type, date, yard, vendor_id, customer_id, party_name, hold_desc, commodity, tier,
                             net_weight, price, total, payment, status, cogs_per_lb, contract_id, po_id, shipment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        ticketId, type, date, yard, vendorId || null, customerId || null,
        snapshotName, holdDesc || null, commodity, tier || null,
        netWeightNum, priceNum, total, payment, type === "buy" ? "Closed" : null,
        cogsPerLb, contractId || null, poId || null, shipmentId || null,
      ]
    );

    await client.query(
      `INSERT INTO inventory_ledger (yard, commodity, type, qty_change, unit_price, balance_qty, avg_cost, cash_cost, ref, date, time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        yard, commodity, ledgerType, type === "buy" ? netWeightNum : -netWeightNum,
        type === "buy" ? priceNum : null, newQty, newAvgCost, Math.round(newQty * newAvgCost * 100) / 100,
        ticketId, date, nowTimeLabel(),
      ]
    );

    if (type === "sell" && contractId) {
      await client.query("UPDATE contracts SET shipped_qty = shipped_qty + $2 WHERE id = $1", [contractId, netWeightNum]);
    }
    if (type === "buy" && poId) {
      await client.query("UPDATE purchase_orders SET received_qty = received_qty + $2 WHERE id = $1", [poId, netWeightNum]);
    }

    await client.query("COMMIT");
    res.status(201).json(ticketRows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "A ticket with that id already exists" });
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
