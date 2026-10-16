const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Yard-Built Assistant — a Claude-powered agent that lives inside the app.
//
// The browser never talks to Anthropic directly: it POSTs the conversation here, this route calls
// the Claude API with a set of READ-ONLY tools that query our own Postgres, loops until Claude has
// what it needs, and returns the answer. The API key lives only on the server (ANTHROPIC_API_KEY
// in Railway's Variables tab). Every tool runs as the signed-in user, so nothing is reachable here
// that the user couldn't already see on screen.
//
// Nothing in here writes to the database on purpose. If/when we want the assistant to *do* things
// (hold a ticket, cut a remittance), add those as explicit tools with a confirmation step in the UI.
// ---------------------------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";
const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 24; // messages kept from the client, oldest dropped first

const YARD_NAMES = { SB: "Scottsbluff (Main, NE)", HAYS: "Hays (KS)", COLBY: "Colby (KS)", RC: "Rapid City (SD)" };

// ---- Tools ---------------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_inventory",
    description:
      "Current on-hand inventory balances (qty, average cost per lb, extended value) by yard and commodity. " +
      "Omit yard for all four yards (corporate rollup). Use this for any 'how much X do we have' question.",
    input_schema: {
      type: "object",
      properties: {
        yard: { type: "string", description: "SB, HAYS, COLBY or RC. Omit for all yards." },
        commodity: { type: "string", description: "Exact commodity code (e.g. CU1). Omit for all commodities." },
        category: { type: "string", description: "Filter by commodity category (Ferrous, Aluminum, Copper, Converter, ...)." },
        only_in_stock: { type: "boolean", description: "Default true: skip zero-qty rows." },
      },
    },
  },
  {
    name: "search_tickets",
    description:
      "Find buy (purchase) or sell (shipment) scale tickets. Supports filtering by yard, type, status " +
      "(Held, Closed, Pending Weight, Voided), paid/unpaid, commodity, date range, and free text on the " +
      "ticket id, dealer/customer name or hold description. Returns newest first.",
    input_schema: {
      type: "object",
      properties: {
        yard: { type: "string" },
        type: { type: "string", enum: ["buy", "sell"] },
        status: { type: "string" },
        paid: { type: "boolean" },
        commodity: { type: "string", description: "Commodity code" },
        q: { type: "string", description: "Ticket id, party name, phone, or hold description fragment" },
        date_from: { type: "string", description: "YYYY-MM-DD inclusive" },
        date_to: { type: "string", description: "YYYY-MM-DD inclusive" },
        limit: { type: "integer", description: "Default 25, max 100" },
      },
    },
  },
  {
    name: "get_ticket",
    description: "Full detail for one ticket by id (e.g. B-1042 or S-2091): party, commodity, weight, price, total, status, freight attached, remittance it was paid on.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "find_party",
    description: "Look up vendors/dealers (people who sell us scrap), customers (who we ship to) and freight carriers by name or phone.",
    input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "get_prices",
    description:
      "Commodity master price list: code, name, category, unit (lb / net_ton / each), master (sale) price per unit, and ferrous flag. " +
      "Filter by category or a name/code fragment. Tier prices for dealers are derived from the master price in the UI; this returns the master only.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string" }, q: { type: "string" } },
    },
  },
  {
    name: "get_volumes",
    description:
      "Purchases and sales totals (lbs and dollars) over a date range, grouped by yard and ferrous vs non-ferrous. " +
      "Excludes voided tickets and internal yard transfers. Use for 'how did we do this week / month' questions.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD" },
        date_to: { type: "string", description: "YYYY-MM-DD" },
        yard: { type: "string" },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "get_payables",
    description:
      "Accounts payable: closed-but-unpaid purchase tickets and unpaid freight, grouped by payee with totals and oldest date. " +
      "Use for 'who do we owe', 'what's waiting for a check', aged payables questions.",
    input_schema: { type: "object", properties: { yard: { type: "string" } } },
  },
  {
    name: "get_contracts",
    description: "Open sales contracts and purchase orders: committed vs shipped/received quantity, remaining, end date, and whether on-hand inventory covers the remainder.",
    input_schema: { type: "object", properties: { yard: { type: "string" }, commodity: { type: "string" } } },
  },
  {
    name: "open_screen",
    description:
      "Navigate the user's Yard-Built window to a screen. Use when the user asks to 'go to', 'open', or 'show me' a part of the app, " +
      "or after answering when the obvious next step is on a specific screen. Routes: dashboard, kiosk (the Purchasing buy kiosk), purchasing (the Cashier screen: held tickets, checks, aged payables), " +
      "sales (Shipment/Contracts), inventory, freight (incl. Dispatch board, containers, box rent), pricelists, commodities, customers, vendors, reports, maintenance, accounting, kbi, documents, settings, " +
      "or ticket (pass ticket_id to open one ticket's page).",
    input_schema: {
      type: "object",
      properties: {
        route: { type: "string" },
        ticket_id: { type: "string", description: "With route 'ticket': the ticket to open, e.g. B-1042" },
        yard: { type: "string", description: "Switch the yard selector too (SB, HAYS, COLBY, RC or CORP)." },
      },
      required: ["route"],
    },
  },
];

function yardClause(params, yard, col = "yard") {
  if (!yard || yard === "CORP") return "";
  params.push(yard.toUpperCase());
  return ` AND ${col} = $${params.length}`;
}

// pg hands DATE columns back as JS Dates at local midnight; Claude just wants YYYY-MM-DD.
function dateReplacer(key, value) {
  if (this && this[key] instanceof Date) {
    const d = this[key];
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return value;
}

async function runTool(name, input, ctx) {
  const params = [];
  switch (name) {
    case "get_inventory": {
      let where = "WHERE 1=1" + yardClause(params, input.yard, "b.yard");
      if (input.commodity) { params.push(input.commodity.toUpperCase()); where += ` AND b.commodity = $${params.length}`; }
      if (input.category) { params.push(input.category); where += ` AND c.category ILIKE $${params.length}`; }
      if (input.only_in_stock !== false) where += " AND b.qty <> 0";
      const { rows } = await query(
        `SELECT b.yard, b.commodity, c.name, c.category, c.unit, b.qty, b.avg_cost,
                ROUND(b.qty * b.avg_cost, 2) AS value, c.master_price,
                CASE WHEN b.avg_cost > c.master_price AND c.master_price > 0 THEN true ELSE false END AS underwater
         FROM inventory_balances b JOIN commodities c ON c.code = b.commodity
         ${where} ORDER BY b.yard, c.category, b.commodity LIMIT 400`,
        params
      );
      const totalValue = rows.reduce((s, r) => s + Number(r.value), 0);
      return { rows, row_count: rows.length, total_value: Math.round(totalValue * 100) / 100, note: "qty is in lbs (or each for 'each' unit); avg_cost is $/lb" };
    }
    case "search_tickets": {
      let where = "WHERE 1=1" + yardClause(params, input.yard);
      if (input.type) { params.push(input.type); where += ` AND type = $${params.length}`; }
      if (input.status) { params.push(input.status); where += ` AND status ILIKE $${params.length}`; }
      if (typeof input.paid === "boolean") { params.push(input.paid); where += ` AND paid = $${params.length}`; }
      if (input.commodity) { params.push(input.commodity.toUpperCase()); where += ` AND commodity = $${params.length}`; }
      if (input.date_from) { params.push(input.date_from); where += ` AND date >= $${params.length}`; }
      if (input.date_to) { params.push(input.date_to); where += ` AND date <= $${params.length}`; }
      if (input.q) { params.push(`%${input.q}%`); where += ` AND (id ILIKE $${params.length} OR party_name ILIKE $${params.length} OR hold_desc ILIKE $${params.length})`; }
      params.push(Math.min(Math.max(parseInt(input.limit, 10) || 25, 1), 100));
      const { rows } = await query(
        `SELECT id, type, date, yard, party_name, hold_desc, commodity, net_weight, price, total, status, paid, payment, kind, contract_id, po_id
         FROM tickets ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
        params
      );
      return { rows, row_count: rows.length };
    }
    case "get_ticket": {
      const { rows } = await query(
        `SELECT t.*, r.check_number, r.method AS remittance_method, r.date AS remittance_date,
                (SELECT json_agg(json_build_object('carrier', ca.name, 'origin', f.origin, 'destination', f.destination, 'cost', f.cost, 'status', f.status, 'paid', f.paid))
                   FROM freight_tickets f LEFT JOIN carriers ca ON ca.id = f.carrier_id
                  WHERE f.ticket_id = t.id AND f.voided_at IS NULL) AS freight
         FROM tickets t LEFT JOIN remittances r ON r.id = t.remittance_id
         WHERE t.id ILIKE $1`,
        [input.id]
      );
      if (!rows[0]) return { error: `No ticket ${input.id}` };
      const { id_snapshot, ...safe } = rows[0]; // seller ID details stay out of the assistant entirely
      return safe;
    }
    case "find_party": {
      const like = `%${input.q}%`;
      const [v, c, ca] = await Promise.all([
        query("SELECT id, name, phone, email, tier, on_price_list FROM vendors WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 15", [like]),
        query("SELECT id, name, phone, email, tier, terms, business_exempt FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 15", [like]),
        query("SELECT id, name, phone, mc, type, is_container_truck FROM carriers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 15", [like]),
      ]);
      return { vendors: v.rows, customers: c.rows, carriers: ca.rows };
    }
    case "get_prices": {
      let where = "WHERE 1=1";
      if (input.category) { params.push(input.category); where += ` AND category ILIKE $${params.length}`; }
      if (input.q) { params.push(`%${input.q}%`); where += ` AND (code ILIKE $${params.length} OR name ILIKE $${params.length})`; }
      const { rows } = await query(
        `SELECT code, name, category, unit, master_price, ferrous FROM commodities ${where} ORDER BY category, name LIMIT 300`,
        params
      );
      return { rows, row_count: rows.length, note: "master_price is per unit shown (lb, net_ton or each)" };
    }
    case "get_volumes": {
      params.push(input.date_from, input.date_to);
      let where = "WHERE t.date >= $1 AND t.date <= $2 AND COALESCE(t.status,'') <> 'Voided' AND COALESCE(t.kind,'') <> 'transfer'" + yardClause(params, input.yard, "t.yard");
      const { rows } = await query(
        `SELECT t.yard, t.type, c.ferrous,
                COUNT(*) AS tickets, SUM(t.net_weight) AS lbs, SUM(t.total) AS dollars
         FROM tickets t JOIN commodities c ON c.code = t.commodity
         ${where} GROUP BY t.yard, t.type, c.ferrous ORDER BY t.yard, t.type, c.ferrous`,
        params
      );
      return { date_from: input.date_from, date_to: input.date_to, rows, note: "lbs = net weight summed; ferrous=true rows are usually quoted in net tons (lbs/2000)" };
    }
    case "get_payables": {
      let w1 = "WHERE type = 'buy' AND status = 'Closed' AND paid = false AND COALESCE(kind,'') <> 'transfer'" + yardClause(params, input.yard);
      const tix = await query(
        `SELECT party_name AS payee, COUNT(*) AS tickets, SUM(total) AS total, MIN(date) AS oldest, MAX(date) AS newest, yard
         FROM tickets ${w1} GROUP BY party_name, yard ORDER BY total DESC LIMIT 100`,
        params
      );
      const fp = [];
      let w2 = "WHERE f.paid = false AND f.voided_at IS NULL AND f.status = 'Reconciled'" + yardClause(fp, input.yard, "t.yard");
      const fr = await query(
        `SELECT COALESCE(ca.name, '(no carrier)') AS carrier, COUNT(*) AS loads, SUM(f.cost) AS total, MIN(f.date) AS oldest
         FROM freight_tickets f JOIN tickets t ON t.id = f.ticket_id LEFT JOIN carriers ca ON ca.id = f.carrier_id
         ${w2} GROUP BY ca.name ORDER BY total DESC LIMIT 100`,
        fp
      );
      const total = tix.rows.reduce((s, r) => s + Number(r.total), 0) + fr.rows.reduce((s, r) => s + Number(r.total), 0);
      return { material_payables: tix.rows, freight_payables: fr.rows, grand_total: Math.round(total * 100) / 100 };
    }
    case "get_contracts": {
      let w = "WHERE 1=1" + yardClause(params, input.yard, "k.yard");
      if (input.commodity) { params.push(input.commodity.toUpperCase()); w += ` AND k.commodity = $${params.length}`; }
      const contracts = await query(
        `SELECT k.id, cu.name AS customer, k.commodity, k.yard, k.committed_qty, k.shipped_qty,
                k.committed_qty - k.shipped_qty AS remaining, k.end_date,
                COALESCE((SELECT SUM(qty) FROM inventory_balances b WHERE b.commodity = k.commodity AND (k.yard = 'CORP' OR b.yard = k.yard)), 0) AS on_hand
         FROM contracts k JOIN customers cu ON cu.id = k.customer_id ${w} ORDER BY k.end_date`,
        params
      );
      const p2 = [];
      let w2 = "WHERE 1=1" + yardClause(p2, input.yard, "p.yard");
      if (input.commodity) { p2.push(input.commodity.toUpperCase()); w2 += ` AND p.commodity = $${p2.length}`; }
      const pos = await query(
        `SELECT p.id, v.name AS vendor, p.commodity, p.yard, p.committed_qty, p.received_qty, p.committed_qty - p.received_qty AS remaining, p.end_date
         FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id ${w2} ORDER BY p.end_date`,
        p2
      );
      return { contracts: contracts.rows, purchase_orders: pos.rows };
    }
    case "open_screen": {
      ctx.actions.push({ type: "navigate", route: input.route, yard: input.yard, ticket_id: input.ticket_id });
      return { ok: true, navigated_to: input.route };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// ---- Prompt ----------------------------------------------------------------------------------

function systemPrompt(user, yard, today) {
  return `You are the Yard-Built assistant, built into Langer Industrial's scrap-yard ERP (Yard-Built). You help scale operators, cashiers, dispatchers, office staff and managers answer questions about the yard using the live database, through the tools you have.

Who you're talking to: ${user.name} (${user.role_name}). The yard selector in their window is currently set to ${yard === "CORP" ? "Corporate (all yards)" : `${yard} — ${YARD_NAMES[yard] || yard}`}. Today is ${today}.

Langer runs four yards: SB (Scottsbluff NE, main), HAYS and COLBY (Kansas — KBI scrap reporting applies), RC (Rapid City SD). "Corporate" / CORP is the rollup of all four, not a real yard.

How the business works, briefly:
- A "buy" ticket is a purchase of scrap from a vendor/dealer at the scale. Purchasing holds it ("Held"), Cashier closes it either Paid (check cut immediately) or Pay Later (goes to AP, paid on a later remittance run). Walk-in buys have no vendor record, just a hold description like "silver Dodge Ram".
- A "sell" ticket is a shipment to a customer (mills, brokers). Several sell tickets can belong to one Shipment (mixed loads). Sell tickets can be linked to a Contract.
- Payment is Check or ACH only — the company never pays cash.
- Prices: every commodity has a master (sale) price; dealers are on a tier (scale < d2 < d1 < dh, dh being the best price) derived from it. Ferrous is quoted per net ton (2000 lb); nonferrous per lb; converters each.
- Inbound freight capitalizes into inventory cost; outbound freight is an AP cost on the shipment.
- Yard transfers (kind = "transfer") are internal and excluded from purchase/sales volumes.

Rules:
- Always use tools for anything about current data. Never guess numbers. If a tool returns nothing, say so plainly rather than inventing.
- Default to the user's currently selected yard unless they say otherwise or ask about "all yards"/"company-wide"; say which yard your answer covers.
- Cite ticket ids (B-####, S-####) and contract/PO numbers so the user can find them.
- Format money with $ and thousands separators; weights in lbs, and in net tons too for ferrous (lbs / 2000). Keep answers short and scannable — a few lines or a small table, not an essay.
- You are read-only. You cannot create, pay, void or edit anything. If asked to, explain which screen does it and offer to open it (open_screen).
- When a question is clearly about a specific screen or the user asks to go somewhere, call open_screen.
- Don't mention tool names or internal mechanics; just answer.`;
}

// ---- Claude API loop -------------------------------------------------------------------------

async function callClaude(body, apiKey) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Keys created at the organization level (not inside a workspace) must say which workspace
      // to bill; keys created inside a workspace don't need this.
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Claude API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  // Claude requires alternating roles starting with user; collapse any doubles.
  const out = [];
  for (const m of clean) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + m.content;
    else out.push(m);
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.slice(-MAX_HISTORY);
}

router.post("/chat", requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "The assistant isn't configured yet — set ANTHROPIC_API_KEY on the server." });
  }
  const messages = sanitizeHistory(req.body.messages);
  if (!messages.length) return res.status(400).json({ error: "Send at least one user message." });

  const yard = (req.body.yard || "SB").toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { user: req.user, yard, actions: [] };
  const convo = messages.slice();
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolsUsed = [];

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const data = await callClaude(
        {
          model: MODEL,
          max_tokens: 1500,
          system: systemPrompt(req.user, yard, today),
          tools: TOOLS,
          messages: convo,
        },
        apiKey
      );
      if (data.usage) {
        usage.input_tokens += data.usage.input_tokens || 0;
        usage.output_tokens += data.usage.output_tokens || 0;
      }

      const toolUses = (data.content || []).filter((b) => b.type === "tool_use");
      if (data.stop_reason !== "tool_use" || !toolUses.length) {
        const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        console.log(`[assistant] ${req.user.name} · ${toolsUsed.length} tool calls · ${usage.input_tokens}+${usage.output_tokens} tokens`);
        return res.json({ reply: text || "(no answer)", actions: ctx.actions, tools_used: toolsUsed, usage });
      }

      // Run every tool Claude asked for, hand the results back, and go around again.
      convo.push({ role: "assistant", content: data.content });
      const results = [];
      for (const tu of toolUses) {
        toolsUsed.push(tu.name);
        let result;
        try {
          result = await runTool(tu.name, tu.input || {}, ctx);
        } catch (err) {
          console.error(`[assistant] tool ${tu.name} failed`, err);
          result = { error: `Tool failed: ${err.message}` };
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result, dateReplacer).slice(0, 60000) });
      }
      convo.push({ role: "user", content: results });
    }
    return res.status(500).json({ error: "The assistant took too many steps without finishing. Try a narrower question." });
  } catch (err) {
    console.error("[assistant]", err);
    const status = err.status === 401 ? 503 : err.status === 429 ? 429 : 502;
    const msg =
      err.status === 401 ? "The server's Claude API key was rejected — check ANTHROPIC_API_KEY." :
      err.status === 429 ? "The assistant is rate-limited right now; try again in a moment." :
      `The assistant couldn't answer: ${err.message}`;
    return res.status(status).json({ error: msg });
  }
});

// Lets the UI show/hide the chat bubble depending on whether the server is configured.
router.get("/status", requireAuth, (req, res) => {
  res.json({ enabled: !!process.env.ANTHROPIC_API_KEY, model: MODEL });
});

module.exports = router;
